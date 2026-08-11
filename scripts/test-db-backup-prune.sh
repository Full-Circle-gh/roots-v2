#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# test-db-backup-prune.sh — can the retention step report its own failure?
#
# The pruning itself works. What did not work, until 2026-08-11, was the step's
# ability to SAY SO when it stopped working: `|| true` on the listing swallowed
# its exit status, a failed delete only printed a warning, and PRUNED never
# reached the log. Today's correct pruned=0 and a future broken pruned=0 were
# byte-identical. That is what this proves is fixed.
#
# THE DEADLINE IS WHY IT MATTERS NOW. The first prune with anything actually
# eligible falls due 2026-08-18. Until then the loop body has never executed in
# production, so the step has never had a chance to fail — and a branch nothing
# reaches is a branch nothing checks.
#
# HOW IT WORKS, following scripts/test-deploy-base.sh:
#   * the retention block is EXTRACTED from the real scripts/db-backup.sh, so
#     the test cannot drift from the thing it tests;
#   * `ossutil` and the ops-alert dispatcher are stubbed on PATH;
#   * everything runs in a mktemp sandbox.
# It never contacts OSS, never touches a database and never runs a backup.
#
# Run: bash scripts/test-db-backup-prune.sh
#      MUTATE=listing bash scripts/test-db-backup-prune.sh   (expect RED)
#      MUTATE=delete  bash scripts/test-db-backup-prune.sh   (expect RED)
#      MUTATE=log     bash scripts/test-db-backup-prune.sh   (expect RED)
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail   # NOT -e: a test harness must not abort on its first failing assertion

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/db-backup.sh"
[ -f "$SRC" ] || { echo "cannot find $SRC"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"; mkdir -p "$BIN"

# ── the block under test, cut out of the real script ─────────────────────────
# From the `trap - ERR` that releases the backup's verdict, to the final exit.
# Extracted rather than reproduced: a copy would let the shipped script drift
# away from what passes here.
BLOCK="$WORK/prune.sh"
awk '/^trap - ERR$/{f=1} f{print} /^exit 0$/{if(f) exit}' "$SRC" > "$BLOCK"
grep -q 'PRUNE_STATUS=ok' "$BLOCK" || { echo "extraction failed — the retention block was not found in $SRC"; exit 2; }

# ── MUTATIONS ────────────────────────────────────────────────────────────────
# v4.27: a mutation must assert it actually changed the source before its red
# counts as evidence. Anchors carry NO line ending — the repo is checked out
# CRLF on the authoring machine and an anchor spanning a newline is exactly the
# fragility that rule exists for.
if [ -n "${MUTATE:-}" ]; then
  BEFORE="$(cat "$BLOCK")"
  case "$MUTATE" in
    # Put back the swallowed listing status: a failed listing looks empty again.
    listing) sed -i 's|^if LISTING=\$("\$OSS" ls "oss://\$BUCKET/daily/" -d 2>&1); then|if LISTING=$("$OSS" ls "oss://$BUCKET/daily/" -d 2>\&1 \|\| true); then|' "$BLOCK" ;;
    # Put back the un-counted delete failure.
    delete)  sed -i 's|^        PRUNE_FAILED=\$((PRUNE_FAILED + 1))|        :|' "$BLOCK" ;;
    # Put back the silent log line.
    log)     sed -i 's|^PRUNE_SUMMARY="prune=.*|PRUNE_SUMMARY=""|' "$BLOCK" ;;
    *) echo "unknown MUTATE=$MUTATE"; exit 2 ;;
  esac
  if [ "$BEFORE" = "$(cat "$BLOCK")" ]; then
    echo "MUTATE=$MUTATE CHANGED NOTHING — every failure below would be meaningless. Aborting."
    exit 2
  fi
  echo "[mutation applied: $MUTATE]"
fi

# ── stubs ────────────────────────────────────────────────────────────────────
# The two fixture prefixes are computed RELATIVE TO TODAY, not hard-coded. The
# first draft used the real prefixes that were in the bucket on 2026-08-11 —
# every one of which is INSIDE the 14-day window, which is precisely why
# production reports pruned=0 — so nothing was ever eligible and four cases
# failed. A fixture whose meaning expires is a test that quietly stops testing.
OLD_PREFIX="$(date -d '60 days ago' +%Y%m%d)-030001"    # always past the cutoff
NEW_PREFIX="$(date +%Y%m%d)-030001"                     # never past the cutoff
export OLD_PREFIX NEW_PREFIX

# ossutil: OSS_MODE picks the behaviour. Listing output mirrors the real
# ossutil 2.1.2 shape, trailing summary line included.
cat > "$BIN/ossutil" <<'STUB'
#!/bin/bash
case "$1" in
  ls)
    case "${OSS_MODE:-ok}" in
      fail)   echo "Error: connection refused" >&2; exit 1 ;;
      empty)  echo "Object and Directory Number is: 0"; exit 0 ;;
      garble) echo "daily/${OLD_PREFIX}/  <DIR>"        # a reformatted listing
              echo "oss://tacet/daily/${OLD_PREFIX}"    # no trailing slash: unparseable
              echo "Object and Directory Number is: 1"; exit 0 ;;
      *)      echo "oss://tacet/daily/${OLD_PREFIX}/"
              echo "oss://tacet/daily/${NEW_PREFIX}/"
              echo "Object and Directory Number is: 2"; exit 0 ;;
    esac ;;
  rm)
    echo "$2" >> "${RM_LOG:-/dev/null}"
    if [ "${RM_MODE:-ok}" = "fail" ]; then exit 1; fi
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$BIN/ossutil"

# node: stands in for the ops-alert dispatcher send_alert() shells out to.
cat > "$BIN/node" <<'STUB'
#!/bin/bash
printf '%s\n' "${@: -1}" >> "${ALERT_LOG:-/dev/null}"
exit 0
STUB
chmod +x "$BIN/node"
export PATH="$BIN:$PATH"

# ── harness ──────────────────────────────────────────────────────────────────
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; echo "        $2"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
has()  { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "expected to contain [$3] in: $2" ;; esac; }
hasnt(){ case "$2" in *"$3"*) bad "$1" "expected NOT to contain [$3] in: $2" ;; *) ok "$1" ;; esac; }

# Drive the block with the surrounding script's variables supplied.
# CUTOFF resolves from RETAIN_DAYS against today, exactly as in production.
run() {
  RUN_DIR="$WORK/run"; rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR"
  export ALERT_LOG="$RUN_DIR/alerts" RM_LOG="$RUN_DIR/removed"
  : > "$ALERT_LOG"; : > "$RM_LOG"
  cat > "$RUN_DIR/driver.sh" <<DRIVER
set -euo pipefail      # MATCHES the real script: -e included, or the test would hide an early exit
OSS="$BIN/ossutil"
BUCKET=tacet
RETAIN_DAYS=14
DATE=20260811-030001
UPLOADED=8
TOTAL_BYTES=751539836
RAW_BYTES=999
APP_DIR="$RUN_DIR"
LOG="$RUN_DIR/db-backup.log"
PRUNE_SUMMARY=''
log_line() {
  mkdir -p "\$(dirname "\$LOG")"
  echo "\$(date -Iseconds) \$1 objects=\$2 bytes=\$3 date=\$DATE\${4:+ reason=\$4}\${PRUNE_SUMMARY:+ \$PRUNE_SUMMARY}" >> "\$LOG"
}
send_alert() { ( cd "\$APP_DIR" && node -e 'x' "\$1" ) || true; }
DRIVER
  cat "$BLOCK" >> "$RUN_DIR/driver.sh"
  OUT="$(cd "$RUN_DIR" && bash "$RUN_DIR/driver.sh" 2>&1)"; RC=$?
  LOGLINE="$(cat "$RUN_DIR/db-backup.log" 2>/dev/null || true)"
  ALERTS="$(cat "$ALERT_LOG" 2>/dev/null || true)"
  REMOVED="$(cat "$RM_LOG" 2>/dev/null || true)"
}

echo
echo "db-backup retention — can it report its own failure?"
echo

# ── CASE 1 — the listing FAILS ───────────────────────────────────────────────
echo "── a listing that FAILS must not look like a healthy run ──"
OSS_MODE=fail RM_MODE=ok; export OSS_MODE RM_MODE; run
has   "log records the failure"            "$LOGLINE" "prune=failed_listing"
has   "ops alert fired"                    "$ALERTS"  "RETENTION did not"
check "nothing was deleted"                "$REMOVED" ""
hasnt "does NOT look like a clean prune"   "$LOGLINE" "prune=ok"
check "the BACKUP's own verdict is intact" "$(printf '%s' "$LOGLINE" | grep -c ' OK objects=8 ')" "1"
check "exit status stays 0 — a good backup is not failed by a prune problem" "$RC" "0"

# ── CASE 2 — a delete FAILS ──────────────────────────────────────────────────
echo "── a delete that FAILS must be counted, alerted and logged ──"
OSS_MODE=ok RM_MODE=fail; export OSS_MODE RM_MODE; run
has  "log records the failure"     "$LOGLINE" "prune=failed_delete"
has  "the failure is COUNTED"      "$LOGLINE" "failed=1"
has  "eligible is reported"        "$LOGLINE" "eligible=1"
has  "removed stays honest at 0"   "$LOGLINE" "removed=0"
has  "ops alert fired"             "$ALERTS"  "prune=failed_delete"

# ── CASE 3 — nothing eligible ────────────────────────────────────────────────
echo "── nothing eligible must still REPORT, and differ from both failures ──"
OSS_MODE=empty RM_MODE=ok; export OSS_MODE RM_MODE; run
has   "log records a clean prune"  "$LOGLINE" "prune=ok"
has   "eligible=0 is written down" "$LOGLINE" "eligible=0"
has   "removed=0 is written down"  "$LOGLINE" "removed=0"
has   "the cutoff is recorded"     "$LOGLINE" "cutoff=$(date -d '14 days ago' +%Y%m%d)"
check "no alert for a healthy run" "$ALERTS"  ""
check "nothing deleted"            "$REMOVED" ""

# ── CASE 3b — the discriminator, stated as one assertion ─────────────────────
echo "── the three states are mutually distinguishable ──"
OSS_MODE=fail  RM_MODE=ok;   export OSS_MODE RM_MODE; run; S1="$LOGLINE"
OSS_MODE=ok    RM_MODE=fail; export OSS_MODE RM_MODE; run; S2="$LOGLINE"
OSS_MODE=empty RM_MODE=ok;   export OSS_MODE RM_MODE; run; S3="$LOGLINE"
p() { printf '%s' "$1" | grep -o 'prune=[a-z_]*' | head -1; }
if [ "$(p "$S1")" != "$(p "$S2")" ] && [ "$(p "$S2")" != "$(p "$S3")" ] && [ "$(p "$S1")" != "$(p "$S3")" ]; then
  ok "failed listing / failed delete / nothing eligible are three different log lines"
else
  bad "the three states are distinguishable" "got [$(p "$S1")] [$(p "$S2")] [$(p "$S3")]"
fi

# ── CASE 4 — a listing that succeeds but no longer parses ────────────────────
echo "── a REFORMATTED listing is not an empty bucket ──"
OSS_MODE=garble RM_MODE=ok; export OSS_MODE RM_MODE; run
has   "log records the parse failure" "$LOGLINE" "prune=failed_parse"
has   "ops alert fired"               "$ALERTS"  "prune=failed_parse"
hasnt "not reported as a clean prune" "$LOGLINE" "prune=ok"

# ── CASE 5 — the happy path still prunes ─────────────────────────────────────
echo "── the eligible set is still actually deleted ──"
OSS_MODE=ok RM_MODE=ok; export OSS_MODE RM_MODE; run
has   "the old set was removed"    "$REMOVED" "$OLD_PREFIX"
hasnt "the recent set was kept"    "$REMOVED" "$NEW_PREFIX"
has   "counted as removed"         "$LOGLINE" "removed=1"
has   "reported clean"             "$LOGLINE" "prune=ok"
check "no alert on success"        "$ALERTS"  ""

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
