#!/usr/bin/env node
/**
 * One-off: empty the three kitchen-request lists.
 *
 * Ash's instruction, 2026-09-09: "ready from the kitchen, waiting on the
 * kitchen — I want to empty those lists completely. It was only tests until
 * now. Don't touch the stock, just clean those lists. Also clean the list of
 * kitchen queue, clean it completely."
 *
 * ── ONE FLAG EMPTIES ALL THREE ────────────────────────────────────────────
 * The three lists are three readings of the same rows — restock_orders (+ their
 * restock_items) with to_role = 'kitchen' — and every one of them filters on
 * `archived_at IS NULL`:
 *
 *   Ready from the kitchen   lib/kitchen-ready.js KITCHEN_READY_WHERE, read by
 *                            the phone's Ready tab, the desktop drawer and the
 *                            dashboard fire
 *   Waiting on the kitchen   GET /api/restock?to_role=kitchen&tab=active
 *   Kitchen queue            the same endpoint, read from the kitchen's side
 *
 * So stamping archived_at on the kitchen-bound orders empties all three at
 * once. That is the mechanism the app itself uses: routes/restock.js calls it a
 * "soft-delete toggle … the row is preserved either way". NOTHING IS DELETED,
 * and PUT /api/restock/:id/archive {archived:false} puts any single row back.
 *
 * ── WHAT IT REFUSES TO TOUCH ──────────────────────────────────────────────
 * STOCK. A kitchen line marked made already granted its stock, and that grant
 * lives in the stock tables, not here. This opens no stock table at all — the
 * suite asserts none is even named. Ash asked for the lists and not the counts,
 * and the counts are the part that cannot be put back by a flag.
 *
 * EVERY OTHER DIRECTION. A store→warehouse transfer is somebody's live work.
 * The direction test is COALESCE(to_role,'warehouse') = 'kitchen', coalesced
 * because `to_role` arrived by migration and reads NULL on rows raised before
 * it — the same reading every surface in the app uses. This is why the existing
 * POST /api/restock/archive-bulk is not what runs here: it has no direction
 * filter and would take the store's transfers with it.
 *
 * OTHER TENANTS. It clears the database it is pointed at and no other. Roots is
 * tenant #1 in roots.db; the per-tenant files (lib/tenant-db.js) are separate
 * businesses and are not swept.
 *
 * ROWS ALREADY ARCHIVED. Their stamp is the record of the day they were
 * archived on, and restamping it would rewrite a fact about a day this did not
 * happen on.
 *
 * IDEMPOTENT. A second run finds nothing unarchived and reports "nothing to do".
 *
 * NO BACKUP IS TAKEN HERE, DELIBERATELY. .github/workflows/oneoff.yml takes one
 * first on the apply path, through SQLite's online .backup API with an
 * integrity_check that aborts the run if it is not "ok". A byte copy from in
 * here would be the weaker thing the decisions doc warns about — roots.db
 * carries a live WAL, so a copy of the main file alone is torn.
 *
 * Default is dry-run.
 *
 *   node scripts/oneoff_clear_kitchen_lists.js          # prints the plan, writes nothing
 *   node scripts/oneoff_clear_kitchen_lists.js --apply  # write
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WRITE = process.argv.includes('--apply');

// The committed lib from THIS checkout when the workflow stages one, the repo's
// own otherwise. The Ready clause is read from it rather than copied: that
// module exists so the fire, the dot and the list cannot disagree about which
// lines count, and a repair clearing a different set than the screen shows
// would be that same disagreement wearing a different hat.
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const kitchenReady = require(path.join(HOME, 'lib', 'kitchen-ready.js'));

const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

const KITCHEN = `COALESCE(r.to_role, 'warehouse') = 'kitchen'`;

const READY_SQL = `
  SELECT COUNT(*) AS n FROM ${kitchenReady.KITCHEN_READY_FROM}
   WHERE ${kitchenReady.KITCHEN_READY_WHERE}`;

// Waiting / Queue: GET /api/restock?to_role=kitchen&tab=active — one endpoint
// read from both sides, so one count answers for both lists.
const ACTIVE_SQL = `
  SELECT COUNT(*) AS n FROM restock_orders r
   WHERE ${KITCHEN}
     AND r.archived_at IS NULL
     AND NOT (r.status = 'delivered'
              OR (r.status = 'prepared' AND ${KITCHEN}))`;

const counts = () => ({
  ready:  db.prepare(READY_SQL).get().n,
  active: db.prepare(ACTIVE_SQL).get().n,
});

const before = counts();
const targets = db.prepare(
  `SELECT r.id, r.rs_number, r.date, r.status, r.created_at,
          (SELECT COUNT(*) FROM restock_items i WHERE i.restock_id = r.id) AS lines
     FROM restock_orders r
    WHERE ${KITCHEN} AND r.archived_at IS NULL
    ORDER BY r.id`).all();

console.log(`\n${WRITE ? 'APPLYING' : 'DRY RUN'} — ${dbPath}\n`);
console.log(`  Ready from the kitchen      ${before.ready} line(s)`);
console.log(`  Waiting on the kitchen      ${before.active} request(s)`);
console.log(`  Kitchen queue               ${before.active} request(s)  (same rows, kitchen's side)`);

if (!targets.length) {
  console.log(`\nNothing to do — no unarchived kitchen request left. The lists are already empty.\n`);
  db.close();
  process.exit(0);
}

console.log(`\n  ${targets.length} kitchen request(s) to archive:\n`);
console.log('    id   | rs_number       | date       | status    | lines');
console.log('    -----+-----------------+------------+-----------+------');
for (const t of targets) {
  console.log(`    ${String(t.id).padStart(4)} | ${String(t.rs_number || '-').padEnd(15)} | ` +
              `${String(t.date || '-').padEnd(10)} | ${String(t.status || '-').padEnd(9)} | ${t.lines}`);
}

// Drafts are named rather than quietly swept: a draft is an unsent request
// somebody may still be writing. It goes — it does appear in the active list —
// but nobody should learn that from the row count afterwards.
const drafts = targets.filter(t => t.status === 'draft');
if (drafts.length) {
  console.log(`\n  ⚠ ${drafts.length} of these are UNSENT DRAFTS (never sent to the kitchen): ` +
              drafts.map(d => d.rs_number).join(', '));
}

console.log(`\n  Stock is NOT touched — no stock table is read or written here.`);
console.log(`  Nothing is deleted — archived_at is a visibility flag, and unarchive puts a row back.`);

if (!WRITE) {
  console.log(`\nDRY RUN — nothing written. Re-run with apply=true once the list above reads right.\n`);
  db.close();
  process.exit(0);
}

const ts = new Date().toISOString();
const changed = db.transaction(() => db.prepare(
  `UPDATE restock_orders
      SET archived_at = ?
    WHERE archived_at IS NULL
      AND COALESCE(to_role, 'warehouse') = 'kitchen'`
).run(ts).changes)();

const after = counts();
console.log(`\n[kitchen] DONE. ${changed} kitchen request(s) archived at ${ts}.`);
console.log(`  Ready from the kitchen      ${after.ready}`);
console.log(`  Waiting on the kitchen      ${after.active}`);
console.log(`  Kitchen queue               ${after.active}`);

// A list that is not empty afterwards means the clause above and the clause the
// screen reads have diverged — which is worth an exit code, not a line of log.
if (after.ready || after.active) {
  console.error(`\n[kitchen] FAILED — a list is still not empty. Report this rather than re-running.`);
  db.close();
  process.exit(1);
}
console.log(`\n[kitchen] All three lists are empty. Nothing was deleted; the backup this`);
console.log(`[kitchen] workflow took before writing is kept on the server.\n`);
db.close();
