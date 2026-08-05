#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# test-deploy-base.sh — offline test of deploy.yml's diff-base resolution.
#
# The base is what decides which files production receives. Get it wrong in one
# direction and files are skipped silently while the run reports SUCCESS — the
# bug this exists to prevent from coming back. So the resolution is tested
# rather than reasoned about.
#
# It extracts the "Compute deployable files" step straight out of the workflow
# (so the test cannot drift from the thing it tests), builds a synthetic repo,
# stubs ssh to stand in for the server's deploy record, and drives every rung of
# the ladder. It never contacts production and never runs a deploy.
#
# Run: bash scripts/test-deploy-base.sh .github/workflows/deploy.yml
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail
WORKFLOW="${1:-.github/workflows/deploy.yml}"
WORKFLOW="$(cd "$(dirname "$WORKFLOW")" && pwd)/$(basename "$WORKFLOW")"
ROOT="$(mktemp -d)"
BIN="$ROOT/bin"; mkdir -p "$BIN"
REPO="$ROOT/repo"

# ── stub ssh: prints whatever MARKER is set to, or fails like a missing file ──
cat > "$BIN/ssh" <<'STUB'
#!/bin/bash
if [ "${MARKER_MODE:-file}" = "unreachable" ]; then exit 255; fi
[ -n "${MARKER:-}" ] && printf '%s\n' "$MARKER"
exit 0
STUB
chmod +x "$BIN/ssh"
export PATH="$BIN:$PATH"

# ── extract the step's script out of the real workflow ────────────────────────
STEP="$ROOT/step.sh"
python3 - "$WORKFLOW" "$STEP" <<'PY'
import yaml, sys, re
d = yaml.safe_load(open(sys.argv[1]))
for s in d['jobs']['deploy']['steps']:
    if s.get('name') == 'Compute deployable files':
        r = s['run']
        break
r = (r.replace('${{ github.event_name }}', '$GH_EVENT')
      .replace('${{ inputs.full_sync }}', '$GH_FULLSYNC')
      .replace('${{ github.event.before }}', '$GH_BEFORE')
      .replace('${{ github.sha }}', '$GH_SHA'))
open(sys.argv[2], 'w').write('#!/bin/bash\n' + r)
PY
chmod +x "$STEP"

# ── synthetic repo: C1 -> C2 -> C3 -> C4, plus a divergent branch ─────────────
git init -q "$REPO"; cd "$REPO"
git config user.email t@t; git config user.name t; git config commit.gpgsign false
mkdir -p lib routes docs
seed() { echo "$2" > "$1"; git add -A; git commit -qm "$3"; }
seed lib/a.js v1 c1;            C1=$(git rev-parse HEAD)
seed lib/b.js v1 c2;            C2=$(git rev-parse HEAD)
seed routes/c.js v1 c3;         C3=$(git rev-parse HEAD)
seed docs/notes.md v1 c4;       C4=$(git rev-parse HEAD)
git checkout -q -b other "$C1"; seed lib/z.js v1 other; OTHER=$(git rev-parse HEAD)
git checkout -q main 2>/dev/null || git checkout -q master

PASS=0; FAIL=0
run() {  # run <marker> <before> <sha> ; sets OUT
  export MARKER="$1" GH_BEFORE="$2" GH_SHA="$3" GH_EVENT=push GH_FULLSYNC=false
  export GITHUB_OUTPUT="$ROOT/out.txt"; : > "$GITHUB_OUTPUT"
  OUT="$(cd "$REPO" && bash "$STEP" 2>&1)"
}
shipped() { printf '%s' "$OUT" | sed -n '/deployable file(s):/,/^Files\|^(same/p' | grep -E '^(lib|routes|public|middleware|scripts)/|^(server|database)\.js$' | sort -u | tr '\n' ' '; }
check() { # check <label> <expected-files>
  local got; got="$(shipped)"
  if [ "$got" = "$2" ]; then PASS=$((PASS+1)); echo "  ok   $1  -> [${got% }]"
  else FAIL=$((FAIL+1)); echo "  FAIL $1"; echo "        expected [$2]"; echo "        got      [$got]"; fi
}

echo "── the bug the fix exists for ──"
# C2's deploy failed, so production is still at C1. Pushing C3 with the OLD base
# (before=C2) skips lib/b.js forever. With the record at C1 it must ship both.
run "$C1" "$C2" "$C3"; check "record C1, push C3 after a failed C2" "lib/b.js routes/c.js "
run ""    "$C2" "$C3"; check "no record: reproduces the old skip"   "routes/c.js "

echo "── the ladder ──"
run "$C2"                                       "$C2" "$C3"; check "record == previous push"        "routes/c.js "
run "not-a-sha"                                 "$C2" "$C3"; check "garbage record -> before"       "routes/c.js "
run "0000000000000000000000000000000000000000"  "$C2" "$C3"; check "unknown sha -> before"           "routes/c.js "
run "$OTHER"                                    "$C2" "$C3"; check "divergent record -> merge-base"  "lib/b.js routes/c.js "
run "$C3"                                       "$C3" "$C3"; check "record == HEAD, nothing new"     ""
run "$C1"                                       ""    "$C4"; check "no before, record C1"            "lib/b.js routes/c.js "

echo "── ssh unreachable ──"
MARKER_MODE=unreachable run "$C1" "$C2" "$C3"
MARKER_MODE=unreachable; export MARKER_MODE
run "$C1" "$C2" "$C3"; check "server unreachable -> before"          "routes/c.js "
unset MARKER_MODE

echo "── docs-only push must ship nothing ──"
run "$C3" "$C3" "$C4"; check "docs-only change"                      ""

echo
echo "$PASS passed, $FAIL failed"
rm -rf "$ROOT"
[ "$FAIL" -eq 0 ]
