#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# rollback-to-sqlite.sh — the reverse of cutover step F1. G22.
#
# Run this ON THE PRODUCTION SERVER. It returns the application to SQLite by
# putting back the file F1 renamed away, and it is deliberately the smallest
# tool that can do that job.
#
# ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────
# THIS IS RESTORE-AND-LOSE. It restores the pre-flip database and does not carry
# anything back from Postgres. Rows written to Postgres during the window are
# NOT merged, NOT copied, and NOT deleted — Postgres is left untouched and
# readable, and scripts/rollback-delta-report.js lists what the window left
# there so a human can work through it afterwards, unhurried.
#
# A REVERSE COPY WAS CONSIDERED AND REJECTED. It cannot be made correct:
#   * Only 40 of 129 non-empty tables carry updated_at, so 89 cannot report that
#     a row CHANGED. retail_customers is one of them, and it holds balance,
#     points_balance, lifetime_spend and tier.
#   * Nine tables have neither an id nor a created_at, so no delta is even
#     definable — storefront_config, channel_status, qingyun_status among them.
#   * Deletes leave no trace at all. Nothing tombstones.
#   * The timestamp direction has a SILENT failure mode: SQLite stored two text
#     forms (naive and ISO-Z) and Postgres stores one instant, so the original
#     form is unrecoverable — and timestamptz renders in the session TimeZone,
#     which on this box is Asia/Shanghai. Get that wrong and every timestamp
#     comes back EIGHT HOURS AHEAD, looking entirely correct.
# See decisions §24. Do not propose it again without answering those four.
#
# ── THIS TOOL IS ONLY VALID BECAUSE THE DAEMONS STOP FOR THE FLIP ───────
# DECIDED 2026-08-20. If the six daemon processes keep writing to SQLite while
# the application writes to Postgres, BOTH databases move and rollback stops
# being a rename — it becomes a two-way merge with conflicts on rows that have
# no updated_at to say which side is newer. That is the tool this file exists
# instead of. Pre-flight refusals R1 and R4 are what enforce the decision: they
# detect a SQLite that moved after the flip and REFUSE.
#
# ── SAFETY ──────────────────────────────────────────────────────────────
#   * DRY RUN BY DEFAULT. --apply is required, and it fails closed.
#   * Every refusal is checked BEFORE anything is stopped, renamed or written.
#   * A rollback that cannot VERIFY it worked exits non-zero. It does not print
#     a warning and return 0.
#   * A receipt is written before the verification runs, so a failed verify
#     still leaves a record of what was done.
#
# USAGE
#   bash scripts/rollback-to-sqlite.sh                     # dry run: pre-flight only
#   bash scripts/rollback-to-sqlite.sh --apply             # do it
#   bash scripts/rollback-to-sqlite.sh --apply --assume-burned 340
#   bash scripts/rollback-to-sqlite.sh --apply --no-reserve-order-range
#   --flip-at <ISO>   override the flip time (default: mtime of .env.pre-cutover)
#
# EXIT  0 done, or a clean dry run · 1 refused, or applied-but-unverified
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP="${RB_APP:-/root/roots-v2}"
DATA="$APP/data"
LIVE="$DATA/roots.db"
PRE="$DATA/roots.db.pre-cutover"
ENVF="$APP/.env"
ENVPRE="$APP/.env.pre-cutover"
# Every external command is overridable so the suite can drive this script
# against a fixture. Defaults are the real thing.
PM2="${RB_PM2:-pm2}"
PSQL="${RB_PSQL:-sudo -u postgres psql -d tacet -tA -v ON_ERROR_STOP=1 -c}"
NODE="${RB_NODE:-node}"

APPLY=0; RESERVE=1; ASSUME_BURNED=""; FLIP_AT_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --no-reserve-order-range) RESERVE=0 ;;
    --assume-burned) ASSUME_BURNED="${2:-}"; shift ;;
    --flip-at) FLIP_AT_OVERRIDE="${2:-}"; shift ;;
    *) echo "unknown argument: $1"; exit 1 ;;
  esac
  shift
done

REFUSALS=()
refuse() { REFUSALS+=("$1"); }
say() { printf '%s\n' "$1"; }

# One SQLite query, through better-sqlite3 — the driver the application already
# depends on. The sqlite3 CLI is not guaranteed to be on the box; this is.
sq() {  # $1 = db path, $2 = sql  -> stdout, or empty on error
  RB_DB="$1" RB_SQL="$2" "$NODE" -e '
    const D = require(process.env.RB_APP_REQ + "/node_modules/better-sqlite3");
    try {
      const db = new D(process.env.RB_DB, { readonly: process.env.RB_RO === "1", fileMustExist: true });
      const r = db.prepare(process.env.RB_SQL).get();
      db.close();
      process.stdout.write(r == null ? "" : String(Object.values(r)[0] ?? ""));
    } catch (e) { process.stderr.write(e.message); process.exit(3); }
  ' 2>/dev/null
}
sq_ro() { RB_RO=1 RB_APP_REQ="$APP" sq "$1" "$2"; }

say "rollback-to-sqlite — $( [ "$APPLY" = 1 ] && echo APPLY || echo 'DRY RUN' )"
say "  app:  $APP"
say ""

# ═══ 1. PRE-FLIGHT ═══════════════════════════════════════════════════════
# THE REFUSALS ARE THE POINT OF THIS TOOL, NOT THE RENAME. A rollback that
# proceeds when it should stop is worse than no rollback tool, because it is
# run at the moment nobody has the attention to second-guess it.
say "PRE-FLIGHT"

# The flip time. F1's companion step copies .env to .env.pre-cutover, so that
# file's mtime is when the flip happened. Overridable because a rollback may
# have to run on a box where that copy was never made.
FLIP_AT=""
if [ -n "$FLIP_AT_OVERRIDE" ]; then
  FLIP_AT=$(date -d "$FLIP_AT_OVERRIDE" +%s 2>/dev/null || echo "")
  [ -z "$FLIP_AT" ] && refuse "--flip-at '$FLIP_AT_OVERRIDE' is not a time this box can parse"
elif [ -f "$ENVPRE" ]; then
  FLIP_AT=$(stat -c %Y "$ENVPRE" 2>/dev/null || echo "")
fi
if [ -n "$FLIP_AT" ]; then
  say "  flip at: $(date -d "@$FLIP_AT" '+%Y-%m-%d %H:%M:%S %z')"
else
  say "  flip at: UNKNOWN (no $ENVPRE and no --flip-at)"
fi

# R0 — is there anything to roll back? Reading .env rather than the process, so
# this answers about the CONFIGURED state, which is what the rename undoes.
if [ -f "$ENVF" ] && grep -qiE '^[[:space:]]*TACET_DB[[:space:]]*=[[:space:]]*postgres[[:space:]]*$' "$ENVF"; then
  say "  R0 ok    — TACET_DB=postgres is set; there is a flip to undo"
else
  refuse "R0: TACET_DB=postgres is not set in $ENVF — there is no flip to roll back. Rolling back a system that is already on SQLite would rename a live database out from under it."
fi

# R1 — a live roots.db must NOT exist. If one does, something recreated it after
# F1 renamed it away: a daemon that reopened, a loose script, or a flip that
# never happened. Either way the file about to be restored is not the only
# candidate, and choosing between them is a merge.
if [ -e "$LIVE" ]; then
  refuse "R1: $LIVE EXISTS. F1 renamed it away, so something recreated it after the flip — a daemon that reopened its handle, or a script that opens the database by path. There are now two SQLite files and picking one is a merge, not a rollback. Find what wrote it before going further."
else
  say "  R1 ok    — no live roots.db"
fi

# R2 — the file we are here to restore.
if [ ! -f "$PRE" ]; then
  refuse "R2: $PRE is MISSING. There is nothing to roll back TO. The hourly snapshots in /root/backups/hourly are a fallback, but they are not the pre-flip file and restoring one loses everything between the snapshot and the flip — that is a different decision and this tool will not make it for you."
else
  say "  R2 ok    — pre-cutover file present ($(stat -c %s "$PRE" 2>/dev/null || echo '?') bytes)"
fi

# R3 — and it has to open. A corrupt file that is restored is an outage on top
# of an outage.
if [ -f "$PRE" ]; then
  IC=$(sq_ro "$PRE" "PRAGMA integrity_check")
  if [ "$IC" = "ok" ]; then
    say "  R3 ok    — PRAGMA integrity_check = ok"
  else
    refuse "R3: $PRE FAILED integrity_check (got '${IC:-<could not open>}'). Restoring it would replace one broken database with another."
  fi
fi

# R4 — THE ONE THAT ENFORCES THE DAEMONS-STOP DECISION. `mv` preserves mtime, so
# this file's mtime is the last write SQLite took before the flip. An open
# better-sqlite3 handle keeps writing to the same INODE after a rename, so a
# daemon that was not stopped goes on writing into roots.db.pre-cutover itself
# and pushes its mtime past the flip. If that happened, both databases moved and
# this tool is the wrong tool.
#
# WITH THE DAEMONS STOPPED THIS CAN NEVER FIRE, WHICH IS EXACTLY WHY IT IS HERE.
# A check that only fires when a decision was not honoured is the check worth
# having.
if [ -f "$PRE" ] && [ -n "$FLIP_AT" ]; then
  PRE_MTIME=$(stat -c %Y "$PRE" 2>/dev/null || echo 0)
  if [ "$PRE_MTIME" -gt "$FLIP_AT" ]; then
    refuse "R4: $PRE was WRITTEN AFTER THE FLIP (file $(date -d "@$PRE_MTIME" '+%H:%M:%S'), flip $(date -d "@$FLIP_AT" '+%H:%M:%S')). Something kept writing to SQLite while the application was on Postgres, so BOTH databases moved. Rollback is a rename only when one side is frozen; this is a merge and this tool will not attempt one. Stop every writer, then decide by hand which side wins."
  else
    say "  R4 ok    — pre-cutover file not written since the flip"
  fi
elif [ -f "$PRE" ]; then
  say "  R4 SKIP  — flip time unknown, cannot check for post-flip writes"
fi

if [ ${#REFUSALS[@]} -gt 0 ]; then
  say ""
  say "REFUSED — ${#REFUSALS[@]} pre-flight check(s) failed. NOTHING HAS BEEN CHANGED."
  for r in "${REFUSALS[@]}"; do say ""; say "  $r"; done
  say ""
  exit 1
fi
say "  all pre-flight checks passed"
say ""

# ═══ 2. THE ORDER-NUMBER HIGH-WATER ══════════════════════════════════════
# The one thing rollback CREATES rather than forgets.
#
# On Postgres, order numbers come from retail_order_counters.last_no. On SQLite
# they come from MAX(CAST(SUBSTR(order_no,3) AS INTEGER)) over retail_orders —
# there is no counter row on that side, and adding one is a change to the
# minting path, which is out of scope here. So restoring the pre-flip file makes
# SQLite resume at the pre-flip maximum and REISSUE every TC number the window
# already gave to a customer.
#
# order_no is TEXT UNIQUE NOT NULL, so a later re-entry of the window's real
# orders collides LOUDLY rather than silently duplicating. That bounds the
# damage; it does not remove it.
say "ORDER-NUMBER HIGH-WATER"
PG_LAST=""
if [ -n "$ASSUME_BURNED" ]; then
  PG_LAST="$ASSUME_BURNED"
  say "  postgres last_no: $PG_LAST (from --assume-burned, not read from the cluster)"
else
  PG_LAST=$($PSQL "SELECT last_no FROM retail_order_counters WHERE series = 'TC'" 2>/dev/null | tr -d '[:space:]')
  if [[ "$PG_LAST" =~ ^[0-9]+$ ]]; then
    say "  postgres last_no: $PG_LAST"
  else
    PG_LAST=""
  fi
fi

SQ_MAX=$(sq_ro "$PRE" "SELECT COALESCE(MAX(CAST(SUBSTR(order_no,3) AS INTEGER)),0) AS n FROM retail_orders WHERE order_no LIKE 'TC______'")
[[ "$SQ_MAX" =~ ^[0-9]+$ ]] || SQ_MAX=0
say "  sqlite max TC:    $SQ_MAX"

RESERVE_AT=""
if [ -z "$PG_LAST" ]; then
  # POSTGRES UNREACHABLE. Refusing to roll back because a counter could not be
  # read would be the wrong trade — the shop is down and the counter is a
  # bookkeeping detail. So: proceed, and say loudly what it costs.
  say "  *** POSTGRES UNREACHABLE — high-water UNKNOWN. Rolling back anyway. ***"
  say "      COST: SQLite resumes at TC$(printf '%06d' $((SQ_MAX + 1))) and may reissue numbers the"
  say "      window already gave out. order_no is UNIQUE, so re-entering a window order later"
  say "      fails loudly rather than duplicating — but a customer can hold a receipt whose"
  say "      number now belongs to somebody else."
  say "      FIX WHEN THE CLUSTER IS BACK:"
  say "        $PSQL \"SELECT last_no FROM retail_order_counters WHERE series='TC'\""
  say "        bash scripts/rollback-to-sqlite.sh --apply --assume-burned <that number>"
  say "      (re-running with only the reservation left to do is safe: the pre-flight refuses"
  say "       once the rename is done, so use scripts/rollback-delta-report.js instead)"
elif [ "$PG_LAST" -le "$SQ_MAX" ]; then
  say "  no gap — postgres never minted past sqlite's maximum. Nothing to reserve."
elif [ "$RESERVE" = 0 ]; then
  say "  gap of $((PG_LAST - SQ_MAX)) number(s), reservation SKIPPED (--no-reserve-order-range)"
  say "      TC$(printf '%06d' $((SQ_MAX + 1)))..TC$(printf '%06d' "$PG_LAST") will be reissued."
else
  RESERVE_AT=$((PG_LAST + 1))
  say "  gap of $((PG_LAST - SQ_MAX)) number(s): TC$(printf '%06d' $((SQ_MAX + 1)))..TC$(printf '%06d' "$PG_LAST")"
  say "  will reserve by inserting ONE cancelled marker order at TC$(printf '%06d' "$RESERVE_AT")"
  say "      Placed ABOVE the burned range, not inside it, so every number the window"
  say "      actually issued stays free for a faithful re-entry."
fi
say ""

# ═══ DRY RUN STOPS HERE ══════════════════════════════════════════════════
if [ "$APPLY" != 1 ]; then
  say "PLAN (nothing written)"
  say "  1. stop roots-v2 and every *-daemon.js process (browser holders untouched)"
  [ -n "$RESERVE_AT" ] && say "  2. insert the reservation marker at TC$(printf '%06d' "$RESERVE_AT")"
  say "  3. mv $PRE -> $LIVE"
  say "  4. remove TACET_DB from $ENVF"
  say "  5. start roots-v2 and the daemons, assert the boot line names sqlite"
  say "  6. run check_ledger_invariants.js and check_points_invariants.js — a failure here fails the rollback"
  say ""
  say "DRY RUN — nothing was changed. Re-run with --apply."
  exit 0
fi

# ═══ 3. STOP EVERYTHING THAT WRITES ══════════════════════════════════════
# Discovered by pm_exec_path, never by a hardcoded name list. The G2 deploy
# proved why: eleme is not running at all, and qingyun runs TWO instances
# (qingyun-sync, qingyun-sync-yuexiu) — six processes across five daemon types,
# not the six types the runbook lists. A name list would have missed one and
# invented another. Browser holders are excluded: they load no business code and
# bouncing one costs a risk-control challenge.
say "STOP"
mapfile -t PROCS < <($PM2 jlist 2>/dev/null | "$NODE" -e '
  let d = []; try { d = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { }
  for (const p of d) {
    const s = (p.pm2_env && p.pm2_env.pm_exec_path) || "";
    if (/-chrome\.js$/.test(s) || /-chrome(-|$)/.test(p.name || "")) continue;
    if (/-daemon\.js$/.test(s) || p.name === "roots-v2") console.log(p.name);
  }' 2>/dev/null)
if [ ${#PROCS[@]} -eq 0 ]; then
  say "  WARNING: pm2 reported no matching processes. Continuing — but if the app is"
  say "  running under a name this did not match, it is still writing."
fi
for n in "${PROCS[@]}"; do
  $PM2 stop "$n" >/dev/null 2>&1 && say "  stopped $n" || say "  WARN: could not stop $n"
done
say ""

# ═══ 4. RESERVE, RENAME, UNSET ═══════════════════════════════════════════
say "RESTORE"
if [ -n "$RESERVE_AT" ]; then
  ON=$(printf 'TC%06d' "$RESERVE_AT")
  OUT=$(RB_APP_REQ="$APP" RB_DB="$PRE" RB_ORDER_NO="$ON" "$NODE" -e '
    const D = require(process.env.RB_APP_REQ + "/node_modules/better-sqlite3");
    const db = new D(process.env.RB_DB, { fileMustExist: true });
    const info = db.prepare(
      "INSERT INTO retail_orders (order_no, status, cancelled_reason, cancelled_at) " +
      "VALUES (?, \x27cancelled\x27, \x27rollback_order_range_reservation\x27, CURRENT_TIMESTAMP)"
    ).run(process.env.RB_ORDER_NO);
    db.close();
    process.stdout.write(String(info.changes));
  ' 2>&1)
  if [ "$OUT" = "1" ]; then
    say "  reserved $ON (one cancelled marker order)"
    say "      remove it once the window's real orders are re-entered:"
    say "      DELETE FROM retail_orders WHERE cancelled_reason = 'rollback_order_range_reservation';"
  else
    say "  WARN: reservation failed ($OUT). Numbers TC$(printf '%06d' $((SQ_MAX + 1)))..TC$(printf '%06d' "$PG_LAST") may be reissued."
  fi
fi

if mv "$PRE" "$LIVE"; then
  say "  restored $LIVE"
else
  say "  FATAL: rename failed. The application is stopped and there is no live database."
  exit 1
fi

if [ -f "$ENVF" ]; then
  cp "$ENVF" "$ENVF.rollback-$(date +%Y%m%d-%H%M%S)"
  # Comment out rather than delete, so the .env still records that a flip
  # happened and was undone. .env is untracked and is the only record either way.
  sed -i -E 's/^([[:space:]]*TACET_DB[[:space:]]*=.*)$/# rolled back: \1/' "$ENVF"
  say "  TACET_DB commented out in $ENVF"
fi
say ""

# ═══ 5. START, THEN ASSERT ═══════════════════════════════════════════════
say "START"
for n in "${PROCS[@]}"; do
  $PM2 start "$n" --update-env >/dev/null 2>&1 || $PM2 restart "$n" --update-env >/dev/null 2>&1
  say "  started $n"
done
sleep "${RB_SETTLE:-4}"

RECEIPT="$DATA/rollback-receipt-$(date +%Y%m%d-%H%M%S).json"
cat > "$RECEIPT" <<JSON
{
  "script": "rollback-to-sqlite.sh",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "flip_at": "$( [ -n "$FLIP_AT" ] && date -d "@$FLIP_AT" -u +%Y-%m-%dT%H:%M:%SZ || echo unknown )",
  "postgres_last_no": "${PG_LAST:-unknown}",
  "sqlite_max_tc_before": "$SQ_MAX",
  "reserved_at": "${RESERVE_AT:-none}",
  "processes": [$(printf '"%s",' "${PROCS[@]}" | sed 's/,$//')],
  "restored": "$LIVE"
}
JSON
say "  receipt: $RECEIPT"
say ""

# A ROLLBACK THAT CANNOT VERIFY IT WORKED MUST FAIL, NOT PRINT.
say "VERIFY"
FAILED=0

BOOT=$($PM2 logs roots-v2 --lines "${RB_LOG_LINES:-200}" --nostream 2>/dev/null | grep -a 'db-driver' | tail -1)
if printf '%s' "$BOOT" | grep -q 'driver: sqlite'; then
  say "  boot line ok — $(printf '%s' "$BOOT" | sed 's/^.*\[db-driver\]/[db-driver]/')"
elif [ -z "$BOOT" ]; then
  say "  FAIL: no [db-driver] line in the log. The process may predate lib/db-driver.js,"
  say "        or it did not come back. Do not assume it is on SQLite."
  FAILED=1
else
  say "  FAIL: the boot line does not name sqlite — $BOOT"
  FAILED=1
fi

for chk in check_ledger_invariants check_points_invariants; do
  if "$NODE" "$APP/scripts/$chk.js" --db "$LIVE" >/dev/null 2>&1; then
    say "  $chk ok"
  else
    say "  FAIL: $chk returned non-zero against the restored database"
    FAILED=1
  fi
done

say ""
if [ "$FAILED" = 0 ]; then
  say "ROLLBACK COMPLETE AND VERIFIED."
  say "Next: bash scripts/rollback-delta-report.js  — what the window left on Postgres."
  exit 0
fi
say "ROLLBACK APPLIED BUT NOT VERIFIED — exit 1. The rename happened; the checks did not pass."
say "Postgres is untouched and still holds the window. Read the receipt: $RECEIPT"
exit 1
