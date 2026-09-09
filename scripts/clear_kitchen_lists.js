#!/usr/bin/env node
/**
 * Empty the three kitchen-request lists: "Ready from the kitchen", "Waiting on
 * the kitchen" and "Kitchen queue".
 *
 * Context: everything raised to the kitchen up to now was test traffic. This
 * clears the lists without deleting a row and WITHOUT TOUCHING STOCK.
 *
 * ONE FLAG EMPTIES ALL THREE. The three lists are three readings of the same
 * rows — restock_orders (+ their restock_items) with to_role = 'kitchen' — and
 * every one of them filters on `archived_at IS NULL`:
 *
 *   Ready from the kitchen   lib/kitchen-ready.js KITCHEN_READY_WHERE
 *                            (`r.archived_at IS NULL`), read by the phone's
 *                            Ready tab, the desktop drawer and the dashboard
 *                            fire
 *   Waiting on the kitchen   GET /api/restock?to_role=kitchen&tab=active
 *   Kitchen queue            the same endpoint, read from the kitchen's side
 *
 * So stamping archived_at on the kitchen-bound orders empties all three at
 * once. That is the mechanism the app itself uses: routes/restock.js calls it
 * a "soft-delete toggle … the row is preserved either way". Nothing is
 * destroyed, and PUT /api/restock/:id/archive {archived:false} puts any single
 * row back.
 *
 * WHY NOT THE BULK-ARCHIVE BUTTON: POST /api/restock/archive-bulk has no
 * direction filter, so it sweeps store→warehouse transfers along with the
 * kitchen ones. This script is scoped to to_role = 'kitchen' and nothing else.
 *
 * STOCK IS NOT TOUCHED. A kitchen line that was marked made already granted
 * its stock, and that grant lives in the stock tables, not here. Archiving the
 * request does not read or write them. Counts stay exactly as they are.
 *
 * SAFE BY DEFAULT:
 *   No --apply        → PREVIEW: per-list counts of what would be cleared.
 *   --apply + token   → backs up the database, then archives in one txn.
 *
 *   node scripts/clear_kitchen_lists.js                     # preview (main DB)
 *   node scripts/clear_kitchen_lists.js --tenant 4          # preview a tenant
 *   node scripts/clear_kitchen_lists.js --apply --confirm <token>
 *
 * Run ON THE SERVER, from the repo root.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const kitchenReady = require('../lib/kitchen-ready');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
function argOf(flag) {
  const i = argv.indexOf(flag);
  return (i === -1 || !argv[i + 1]) ? null : argv[i + 1].trim();
}

// ── Which database ─────────────────────────────────────────────────────────
// Tenant #1 (Roots) is the shared main roots.db; every other tenant is its own
// file (lib/tenant-db.js). A tenant is named explicitly rather than swept
// implicitly: each one is a different business, and "all of them at once" is
// what an over-broad selector looks like.
const DATA_DIR = path.join(__dirname, '..', 'data');
const tenant = argOf('--tenant');
const DB_PATH = tenant
  ? path.join(DATA_DIR, 'tenants', `${tenant}.db`)
  : path.join(DATA_DIR, 'roots.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`[kitchen] DB not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// The kitchen direction, written once. `to_role` arrived by migration and is
// NULL on rows that predate it, which is why every reader in the app coalesces
// it to 'warehouse' rather than comparing the column raw.
const KITCHEN = `COALESCE(r.to_role, 'warehouse') = 'kitchen'`;

// What each list shows, in its own words.
//
// Ready comes from lib/kitchen-ready.js rather than a copy: the module exists
// so the fire, the dot and the list cannot disagree about which lines count,
// and a script that cleared a different set than the screen shows would be the
// same disagreement wearing a different hat.
const READY_SQL = `
  SELECT COUNT(*) AS n FROM ${kitchenReady.KITCHEN_READY_FROM}
   WHERE ${kitchenReady.KITCHEN_READY_WHERE}`;

// Waiting / Queue: GET /api/restock?to_role=kitchen&tab=active, which is one
// endpoint read from both sides — the warehouse's "Waiting on the kitchen" and
// the kitchen's own "Kitchen queue".
const ACTIVE_SQL = `
  SELECT COUNT(*) AS n FROM restock_orders r
   WHERE ${KITCHEN}
     AND r.archived_at IS NULL
     AND NOT (r.status = 'delivered'
              OR (r.status = 'prepared' AND ${KITCHEN}))`;

function counts() {
  return {
    ready:  db.prepare(READY_SQL).get().n,
    active: db.prepare(ACTIVE_SQL).get().n,
  };
}

const before = counts();
const orders = db.prepare(
  `SELECT COUNT(*) AS n FROM restock_orders r WHERE ${KITCHEN} AND r.archived_at IS NULL`
).get().n;
const drafts = db.prepare(
  `SELECT COUNT(*) AS n FROM restock_orders r
    WHERE ${KITCHEN} AND r.archived_at IS NULL AND r.status = 'draft'`
).get().n;

console.log(`\n${APPLY ? 'APPLYING' : 'PREVIEW'} — ${path.relative(process.cwd(), DB_PATH)}\n`);
console.log(`  Ready from the kitchen      ${before.ready} line(s)`);
console.log(`  Waiting on the kitchen      ${before.active} request(s)`);
console.log(`  Kitchen queue               ${before.active} request(s)  (same rows, kitchen's side)`);
console.log(`\n  Kitchen requests to archive ${orders}`);
if (drafts) {
  // Called out rather than quietly swept: a draft is an unsent request somebody
  // may still be writing. It is included because it does appear in the active
  // list, but nobody should learn that from the row count afterwards.
  console.log(`    …of which UNSENT DRAFTS    ${drafts}  ← not yet sent to the kitchen`);
}
console.log(`\n  Stock is NOT touched. No stock table is read or written by this script.`);

if (!orders) {
  console.log(`\nNothing to do — the lists are already empty.\n`);
  db.close();
  process.exit(0);
}

// Preview-before-apply, enforced, as decisions §24 requires of a destructive
// script that ships to production. The token is derived from the target, so a
// token read off one database cannot authorise a sweep of another.
const CONFIRM_FLAG = '--confirm';
const token = require('crypto').createHash('sha256')
  .update(path.resolve(DB_PATH)).digest('hex').slice(0, 8);

if (!APPLY) {
  console.log(`\nPREVIEW only — nothing written.`);
  console.log(`To clear exactly this, re-run with BOTH flags:`);
  console.log(`  node ${path.relative(process.cwd(), __filename)}${tenant ? ` --tenant ${tenant}` : ''} --apply ${CONFIRM_FLAG} ${token}\n`);
  db.close();
  process.exit(0);
}
if (argOf(CONFIRM_FLAG) !== token) {
  console.error(`\n[kitchen] REFUSED — --apply needs ${CONFIRM_FLAG} <token> from a preview of this database.`);
  console.error(argOf(CONFIRM_FLAG)
    ? `  The token given belongs to a different database, so it cannot authorise this one.`
    : `  No token given. Run without --apply first and read what it would clear.`);
  console.error(`\n  Preview:  node ${path.relative(process.cwd(), __filename)}${tenant ? ` --tenant ${tenant}` : ''}\n`);
  db.close();
  process.exit(1);
}

const ts = new Date().toISOString();
const backup = path.join(DATA_DIR, `${path.basename(DB_PATH, '.db')}-prekitchenclear-${ts.replace(/[:.]/g, '-')}.db`);
db.pragma('wal_checkpoint(TRUNCATE)');
fs.copyFileSync(DB_PATH, backup);
console.log(`\n[kitchen] backup written: ${backup}`);

const changed = db.transaction(() => db.prepare(
  `UPDATE restock_orders
      SET archived_at = ?
    WHERE archived_at IS NULL
      AND COALESCE(to_role, 'warehouse') = 'kitchen'`
).run(ts).changes)();

const after = counts();
console.log(`\n[kitchen] DONE. ${changed} kitchen request(s) archived.`);
console.log(`  Ready from the kitchen      ${after.ready}`);
console.log(`  Waiting on the kitchen      ${after.active}`);
console.log(`  Kitchen queue               ${after.active}`);
if (after.ready || after.active) {
  console.error(`\n[kitchen] WARNING: a list is still not empty. Report this rather than re-running.`);
}
console.log(`\n[kitchen] Nothing was deleted. Restore everything with:`);
console.log(`  cp "${backup}" "${DB_PATH}"   (then restart the app)\n`);
db.close();
