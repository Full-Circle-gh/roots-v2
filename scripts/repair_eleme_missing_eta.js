#!/usr/bin/env node
/**
 * Backfill channel_eta on mirrored Eleme orders that have none, from the ETA
 * their own archived payload carries — and then let the sweep that already
 * exists land them.
 *
 * WHY. Until 2026-09-04 lib/eleme-browser.js looked for the ETA under six
 * guessed key names, none of which appears in Eleme's payload, so channel_eta
 * is NULL on every order mirrored before that. NULL there is not a blank cell:
 * /api/internal/eleme/auto-deliver-past-eta compares against it, so an order
 * with no ETA can never be landed by that sweep and stalls at whatever the last
 * poll left it — which, for an order that has since dropped off Eleme's
 * in-progress tab, is forever. That is the two orders sitting on Paid.
 *
 * The real field is header.planDeliverTime, an epoch in milliseconds, MEASURED
 * on the live archive by scripts/diagnose_eleme_stage_replay.js.
 *
 * WHAT THIS WRITES, AND WHAT IT DELIBERATELY DOES NOT. One column:
 * retail_orders.channel_eta, and only where it is currently empty. It does NOT
 * touch `status`.
 *
 * That restraint is the whole design. The archived payload is the order as it
 * looked AT IMPORT, so the stage in it is the stage the order had then, not the
 * one it ended at — writing that stage now would stamp a delivered order with
 * "preparing" and call it a repair. The ETA is different in kind: a promised
 * delivery time does not go stale, it is a fact about that payload, and it is
 * the input the shipped rule already uses. So this restores the input and lets
 * the ONE rule decide, rather than adding a second rule that guesses outcomes.
 *
 * After this runs, the daemon's half-hourly sweep (or a direct POST to
 * /api/internal/eleme/auto-deliver-past-eta) marks any of these orders delivered
 * if it is more than an hour past the ETA Eleme itself promised — exactly the
 * test every future Eleme order will face.
 *
 * SAFETY, in the order it runs:
 *   1. Scope is eleme orders, non-terminal, with an EMPTY channel_eta. A row
 *      that already carries one is never rewritten.
 *   2. Every value comes from that row's OWN archived payload. A row whose
 *      archive is missing, truncated past parsing, or carries no
 *      header.planDeliverTime is REPORTED AND SKIPPED, never filled from a
 *      neighbour or from the clock.
 *   3. The ETA must be a plausible timestamp AFTER that order's own placed_at
 *      and within 24h of it. A promised delivery before the order was placed is
 *      a misparse, and it aborts rather than writing it.
 *   4. --apply takes a backup with sqlite3's online .backup API first — never
 *      cp, because roots.db carries a live WAL and a byte copy would be torn —
 *      then runs PRAGMA integrity_check on the copy and refuses to continue
 *      unless it answers "ok".
 *   5. One transaction. After each write, still inside it, `status` is re-read
 *      and must be unchanged — this script has no business moving an order and
 *      proves it rather than promising it.
 *
 * Dry run unless --apply is passed; the dry run prints exactly what --apply
 * would do and takes no backup, because it writes nothing.
 *
 * Usage, on the box (cd /root/roots-v2):
 *   node scripts/repair_eleme_missing_eta.js            # survey, no write
 *   node scripts/repair_eleme_missing_eta.js --apply    # back up, then write
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));

const APPLY = process.argv.slice(2).includes('--apply');

// The one field, by the path the archive actually carries it at.
const P_ETA = 'header.planDeliverTime';

const atPath = (obj, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const die = (msg) => { console.error(`\nABORT: ${msg}`); process.exit(1); };

// Same conversion lib/eleme-browser.js applies, restated rather than imported:
// requiring the browser module here would pull in its whole runtime for one
// arithmetic step, and a repair should depend on as little as it can.
function toUtcStamp(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    let n = Number(v);
    if (!n) return null;
    if (n < 1e11) n *= 1000;
    if (n < 1e12) return null;
    return new Date(n).toISOString().slice(0, 19).replace('T', ' ');
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(v).trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

console.log(`repair_eleme_missing_eta — ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no write)'}`);
console.log(`db: ${db.name}\n`);

const rows = db.prepare(`
  SELECT o.id, o.order_no, o.status, o.placed_at, o.channel_eta,
         i.eleme_order_id, i.raw_payload
    FROM retail_orders o
    JOIN eleme_order_import i ON i.retail_order_id = o.id
   WHERE o.channel = 'eleme'
     AND o.status IN ('paid','preparing','rider_pickup','dispatched')
     AND COALESCE(o.channel_eta, '') = ''
   ORDER BY o.id
`).all();

if (!rows.length) {
  console.log('No non-terminal Eleme order is missing its ETA. Nothing to do.');
  process.exit(0);
}
console.log(`${rows.length} non-terminal Eleme order(s) with no ETA:\n`);

const plan = [];
for (const r of rows) {
  const raw = parseJson(r.raw_payload);
  if (!raw) {
    console.log(`  ${r.order_no} (id ${r.id})  SKIP — archived payload missing or unparseable`);
    continue;
  }
  const eta = toUtcStamp(atPath(raw, P_ETA));
  if (!eta) {
    console.log(`  ${r.order_no} (id ${r.id})  SKIP — no ${P_ETA} in its archive`);
    continue;
  }
  // Guard 3: the promise must come after the order, and inside a day of it.
  const placed = r.placed_at ? Date.parse(r.placed_at.replace(' ', 'T') + 'Z') : NaN;
  const promised = Date.parse(eta.replace(' ', 'T') + 'Z');
  if (Number.isFinite(placed)) {
    if (promised < placed) die(`${r.order_no}: ETA ${eta} is BEFORE placed_at ${r.placed_at} — that is a misparse, not a promise`);
    if (promised - placed > 24 * 3600 * 1000) die(`${r.order_no}: ETA ${eta} is more than 24h after placed_at ${r.placed_at}`);
  }
  const hoursPast = Number.isFinite(promised) ? ((Date.now() - promised) / 3600000).toFixed(1) : '?';
  console.log(`  ${r.order_no} (id ${r.id})  status=${r.status}  placed=${r.placed_at}`);
  console.log(`     channel_eta: NULL → ${eta}   (${hoursPast}h past now — the sweep lands anything over 1h)`);
  plan.push({ id: r.id, orderNo: r.order_no, status: r.status, eta });
}

if (!plan.length) { console.log('\nNothing writable. Exiting without changes.'); process.exit(0); }

if (!APPLY) {
  console.log(`\nDRY RUN — ${plan.length} row(s) would be written. Re-run with --apply.`);
  console.log('After applying, the daemon sweeps every 30 min; to land them at once:');
  console.log(`  curl -s -XPOST localhost:4000/api/internal/eleme/auto-deliver-past-eta \\
    -H "X-Internal-Secret: $ELEME_INTERNAL_SECRET"`);
  process.exit(0);
}

// Guard 4 — a real backup, taken through SQLite rather than the filesystem.
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
const backup = path.join('/root/backups', `roots-eleme-eta-${stamp}.db`);
fs.mkdirSync('/root/backups', { recursive: true });
console.log(`\nBacking up to ${backup} …`);
try {
  execFileSync('sqlite3', [db.name, `.backup '${backup}'`], { stdio: 'inherit' });
} catch (e) {
  die(`backup failed: ${e.message}`);
}
if (!fs.existsSync(backup) || fs.statSync(backup).size < 1024) die('backup file is missing or implausibly small');
const check = execFileSync('sqlite3', [backup, 'PRAGMA integrity_check;']).toString().trim();
if (check !== 'ok') die(`backup failed integrity_check: ${check}`);
console.log(`backup OK (${(fs.statSync(backup).size / 1048576).toFixed(1)} MB, integrity_check = ok)`);

const write = db.transaction(() => {
  let n = 0;
  for (const p of plan) {
    const before = db.prepare('SELECT status FROM retail_orders WHERE id = ?').get(p.id);
    const r = db.prepare(
      "UPDATE retail_orders SET channel_eta = ? WHERE id = ? AND COALESCE(channel_eta,'') = ''"
    ).run(p.eta, p.id);
    if (r.changes !== 1) throw new Error(`${p.orderNo}: expected 1 row changed, got ${r.changes}`);
    // Guard 5: this script does not move orders, and proves it here.
    const after = db.prepare('SELECT status, channel_eta FROM retail_orders WHERE id = ?').get(p.id);
    if (after.status !== before.status) throw new Error(`${p.orderNo}: status changed (${before.status} → ${after.status})`);
    if (after.channel_eta !== p.eta) throw new Error(`${p.orderNo}: channel_eta did not take`);
    n++;
  }
  if (n !== plan.length) throw new Error(`wrote ${n} of ${plan.length}`);
  return n;
});

let wrote = 0;
try { wrote = write(); } catch (e) { die(`rolled back: ${e.message}`); }
console.log(`\nWrote ${wrote} row(s). Status untouched on every one, as asserted inside the transaction.`);
console.log('The half-hourly sweep will land anything more than an hour past its ETA;');
console.log('POST /api/internal/eleme/auto-deliver-past-eta does it immediately.');
