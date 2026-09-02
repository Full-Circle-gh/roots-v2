#!/usr/bin/env node
/**
 * Delete the five phantom Eleme rows from retail_orders.
 *
 * They are not orders. The Eleme order-locator, before b1e2db5 (31 Aug),
 * promoted LINE ITEMS to orders: looksLikeOrder() accepted any row with a
 * top-level id of six or more characters plus a total — which a food has, a food
 * id beside a per-food 总价 — and findArray() then took the LARGEST qualifying
 * array, so one order's three foods outvoted the one-member array holding the
 * order. Each of these five rows is one food object, and its stored
 * eleme_order_id is that food's own id.
 *
 * The three from 31 Aug (¥50 + ¥47 + ¥38 = ¥135) are the line items of
 * EL20260831339491 — retail_orders id 1502, subtotal 135, three priced lines at
 * exactly 50/47/38 — which the first poll after the fix imported correctly. That
 * order is currently counted twice. The two from 30 Aug (¥64 + ¥45) belong to an
 * order that was never imported and cannot be recovered here; that is manual
 * entry, handled separately, and this script does not attempt it.
 *
 * WHAT THIS DELETES, AND WHAT IT DELIBERATELY DOES NOT.
 *   • DELETES: five rows from retail_orders, and nothing else. A live survey of
 *     all 171 tables — every declared foreign key to retail_orders, then every
 *     column NAME that could hold an order id without one — found exactly one
 *     table holding a reference, eleme_order_import, and zero rows in every
 *     other. Nothing cascades because every cascade target matches zero rows.
 *   • KEEPS eleme_order_import. Its FK is ON DELETE SET NULL, so those five rows
 *     survive as tombstones with retail_order_id NULL. That is deliberate and
 *     protective: the daemon's dedup reads this table, so a food id marked
 *     already-seen is what stops a regression in the locator from re-creating
 *     these rows. A food id must never be accepted as an order id, so "already
 *     seen" is the right state for one, not a stale entry to clear.
 *   • KEEPS eleme_sync_log. It is append-only — nothing in the repository
 *     deletes from it — and its five order_import lines are the record that this
 *     happened at all.
 *
 * NEVER TOUCHED: retail_orders id 1502 (EL20260831339491) and id 1538
 * (EL20260901417897), the two real Eleme orders — asserted, not merely avoided;
 * and miniapp_order_lines, whose order_id is a foreign key to miniapp_orders.id
 * (database.js:1209), a separate id space whose ids collide with these by
 * coincidence. A name-based reference scan reports 43 rows there and every one
 * of them belongs to a different table's orders.
 *
 * SAFETY, in the order it runs:
 *   1. Rows are addressed by eleme_order_id — the food id — through the
 *      eleme_order_import join, never by a hardcoded retail_orders.id. A row
 *      that has moved cannot be hit by accident.
 *   2. Every target is re-verified: no line items, no customer, no stock ledger
 *      row (by ref AND by a note naming it), channel eleme. Any failure aborts.
 *   3. --apply takes a backup with sqlite3's online .backup API — never cp,
 *      because roots.db carries a live WAL and a byte copy would be torn — then
 *      runs PRAGMA integrity_check on the copy and refuses to continue unless it
 *      answers "ok" AND the copy still holds the rows about to be deleted.
 *   4. The verification runs AGAIN inside the transaction, against the same rows,
 *      so a change landing between survey and delete rolls the whole thing back.
 *   5. Exactly five rows must go. Any other count rolls back.
 *
 * Dry run unless --apply is passed; the dry run prints exactly what --apply would
 * do, and takes no backup because it writes nothing.
 *
 * Usage, on the box (cd /root/roots-v2):
 *   node scripts/repair_eleme_phantom_orders.js            # survey, no write
 *   node scripts/repair_eleme_phantom_orders.js --apply    # back up, then delete
 *
 * The read-only twin, runnable from Actions without a shell on the box, is
 * scripts/diagnose_phantom_order_refs.js.
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));

const APPLY = process.argv.slice(2).includes('--apply');

// The five, addressed by the one thing that identifies them unambiguously: the
// food id sitting in eleme_order_id where an order id belongs.
const FOOD_IDS = [
  '2000001755518659',  // EL20260830933393  ¥64
  '2000001755174220',  // EL20260830921999  ¥45
  '2000001755025071',  // EL20260831895225  ¥50
  '2000001755039997',  // EL20260831559705  ¥47
  '2000001755697753',  // EL20260831335758  ¥38
];
// The two real orders. Named so the guard below is an assertion about them
// rather than a hope that the join never reaches them.
const PROTECTED_IDS = [1502, 1538];
const EXPECT_COUNT  = 5;

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const die = (msg) => { console.error(`\nABORT: ${msg}`); process.exit(1); };

console.log(`repair_eleme_phantom_orders — ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no write)'}`);
console.log(`db: ${db.name}\n`);

// Foreign keys are enforced PER CONNECTION in SQLite and default to off. database.js
// sets this for its own handle; setting it here as well makes the guarantee this
// script depends on explicit rather than inherited, and it is then read back —
// a pragma that silently failed to take would leave the SET NULL on
// eleme_order_import.retail_order_id unfired and the tombstones dangling.
db.pragma('foreign_keys = ON');
const fkOn = db.pragma('foreign_keys', { simple: true });
if (Number(fkOn) !== 1) die(`foreign_keys is ${fkOn}, not 1 — refusing to delete with FK enforcement off`);
console.log('foreign_keys = ON (read back and confirmed)\n');

// ── Totals before ──────────────────────────────────────────────────────────
const totals = () => db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(subtotal),0) AS subtotal
    FROM retail_orders WHERE channel = 'eleme'
`).get();
const windowTotals = () => db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(subtotal),0) AS subtotal
    FROM retail_orders
   WHERE channel = 'eleme'
     AND DATE(COALESCE(placed_at, paid_at)) BETWEEN '2026-08-30' AND '2026-09-01'
`).get();

const beforeAll = totals();
const beforeWin = windowTotals();
console.log('── before ───────────────────────────────────────────────────');
console.log(`   eleme rows, 30 Aug – 1 Sep : count=${beforeWin.n}  SUM(total)=${r2(beforeWin.total)}  SUM(subtotal)=${r2(beforeWin.subtotal)}`);
console.log(`   eleme rows, all time       : count=${beforeAll.n}  SUM(total)=${r2(beforeAll.total)}  SUM(subtotal)=${r2(beforeAll.subtotal)}\n`);

// ── Resolve and verify ─────────────────────────────────────────────────────
// One statement, reused by the pre-flight below and by the in-transaction
// re-check, so the two can never drift into asking different questions.
const verifyOne = (fid) => {
  const row = db.prepare(`
    SELECT o.id, o.order_no, o.channel, o.status, o.subtotal, o.total,
           o.customer_id, o.store_id, o.channel_settle_amount,
           i.id AS import_id, i.imported_at
      FROM eleme_order_import i
      JOIN retail_orders o ON o.id = i.retail_order_id
     WHERE i.eleme_order_id = ?
  `).get(fid);
  if (!row) return { fid, row: null, problems: ['no retail_orders row joined to this eleme_order_id'] };

  const lines = db.prepare('SELECT COUNT(*) AS n FROM retail_order_items WHERE order_id = ?').get(row.id).n;
  const ledgerRef = db.prepare(
    "SELECT COUNT(*) AS n FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id = ?"
  ).get(row.id).n;
  // A movement that names the order in a note without keying on it is still a
  // movement, and the note is where the Eleme ingest writes the reference.
  const ledgerNote = db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger WHERE note LIKE ? OR note LIKE ?')
    .get('%' + fid + '%', '%' + row.order_no + '%').n;

  const problems = [];
  if (row.channel !== 'eleme')        problems.push(`channel is '${row.channel}', not eleme`);
  if (lines !== 0)                    problems.push(`has ${lines} line item(s)`);
  if (row.customer_id != null)        problems.push(`has customer_id=${row.customer_id}`);
  if (ledgerRef !== 0)                problems.push(`has ${ledgerRef} stock ledger row(s) by ref`);
  if (ledgerNote !== 0)               problems.push(`has ${ledgerNote} stock ledger row(s) naming it`);
  if (PROTECTED_IDS.includes(row.id)) problems.push(`resolves to PROTECTED order id ${row.id} — refusing`);
  return { fid, row, lines, ledgerRef, ledgerNote, problems };
};

console.log('── the five, re-verified ────────────────────────────────────');
const checks = FOOD_IDS.map(verifyOne);
let bad = 0;
for (const c of checks) {
  if (!c.row) { console.log(`   ${c.fid}: ${c.problems.join('; ')}`); bad++; continue; }
  const ok = c.problems.length === 0;
  if (!ok) bad++;
  console.log(`   ${c.fid} → id ${c.row.id} (${c.row.order_no})  ${c.row.status}  subtotal=${c.row.subtotal} total=${c.row.total}`);
  console.log(`      lines=${c.lines} customer_id=${c.row.customer_id} ledger(ref/note)=${c.ledgerRef}/${c.ledgerNote}  →  ${ok ? 'OK to delete' : '*** ' + c.problems.join('; ') + ' ***'}`);
}
console.log('');

const targets = checks.filter(c => c.row && c.problems.length === 0).map(c => c.row.id);
if (bad > 0) die(`${bad} of ${FOOD_IDS.length} row(s) no longer match the verified description — nothing deleted`);
if (targets.length !== EXPECT_COUNT) die(`resolved ${targets.length} target(s), expected ${EXPECT_COUNT} — nothing deleted`);
for (const p of PROTECTED_IDS) {
  if (targets.includes(p)) die(`target set contains protected order id ${p} — nothing deleted`);
}
console.log(`   ${targets.length} row(s) verified: [${targets.join(', ')}]`);
console.log(`   protected and untouched: [${PROTECTED_IDS.join(', ')}]\n`);

// ── Dry run stops here ─────────────────────────────────────────────────────
if (!APPLY) {
  const afterN   = beforeAll.n - targets.length;
  const removed  = checks.reduce((a, c) => a + (Number(c.row.total) || 0), 0);
  const removedS = checks.reduce((a, c) => a + (Number(c.row.subtotal) || 0), 0);
  console.log('── what --apply would do ────────────────────────────────────');
  console.log(`   1. sqlite3 .backup of ${db.name} to /root/backups/pre-phantom-delete-<timestamp>.db`);
  console.log('   2. PRAGMA integrity_check on the copy; must answer "ok"');
  console.log('   3. confirm the copy still holds the rows about to go');
  console.log(`   4. DELETE ${targets.length} row(s) from retail_orders, in one transaction`);
  console.log('   5. re-verify inside that transaction; roll back on any change');
  console.log(`   6. require exactly ${EXPECT_COUNT} rows changed, else roll back`);
  console.log('');
  console.log(`   projected after: eleme count ${beforeAll.n} → ${afterN},`
    + ` SUM(total) ${r2(beforeAll.total)} → ${r2(beforeAll.total - removed)},`
    + ` SUM(subtotal) ${r2(beforeAll.subtotal)} → ${r2(beforeAll.subtotal - removedS)}`);
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to perform it.');
  process.exit(0);
}

// ── Backup ─────────────────────────────────────────────────────────────────
// sqlite3's online .backup API, exactly as scripts/install-backup-cron.sh does
// it. NEVER cp: roots.db runs in WAL mode, so a byte copy of the main file alone
// is torn or stale. If the sqlite3 CLI is missing this aborts rather than
// falling back — a weaker backup is not a backup for a delete.
const SRC = db.name;
// /root/backups is where scripts/install-backup-cron.sh already puts hourly
// snapshots, so a pre-delete copy lands beside them rather than somewhere new.
// PHANTOM_BACKUP_DIR exists only so the test harness can point the backup at a
// scratch directory; on the box it is unset and the default is what runs.
const BACKUP_DIR = process.env.PHANTOM_BACKUP_DIR || '/root/backups';
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const DEST = path.join(BACKUP_DIR, `pre-phantom-delete-${stamp}.db`);

try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) { die(`cannot create ${BACKUP_DIR}: ${e.message}`); }
try { execFileSync('sqlite3', ['--version'], { stdio: 'pipe' }); }
catch (e) { die('the sqlite3 CLI is not available — refusing to back up with cp, and refusing to delete without a backup'); }

console.log('── backup ───────────────────────────────────────────────────');
try {
  execFileSync('sqlite3', [SRC, `.backup '${DEST}'`], { stdio: 'pipe' });
} catch (e) { die(`sqlite3 .backup failed: ${String(e.stderr || e.message).slice(0, 300)}`); }
if (!fs.existsSync(DEST)) die(`backup file was not created at ${DEST}`);
console.log(`   backup: ${DEST}  (${fs.statSync(DEST).size} bytes)`);

let integrity = '';
try {
  integrity = String(execFileSync('sqlite3', [DEST, 'PRAGMA integrity_check;'], { stdio: 'pipe' })).trim();
} catch (e) { die(`integrity_check could not run on the backup: ${String(e.stderr || e.message).slice(0, 200)}`); }
console.log(`   PRAGMA integrity_check: ${integrity}`);
if (integrity !== 'ok') die(`integrity_check on the backup answered "${integrity}", not "ok" — nothing deleted`);

// A backup taken after the delete would restore nothing. Prove it holds the rows.
let inBackup = '';
try {
  inBackup = String(execFileSync('sqlite3', [DEST,
    `SELECT COUNT(*) FROM retail_orders WHERE id IN (${targets.join(',')});`], { stdio: 'pipe' })).trim();
} catch (e) { die(`could not read the backup back: ${String(e.stderr || e.message).slice(0, 200)}`); }
console.log(`   rows about to be deleted, present in the backup: ${inBackup}`);
if (Number(inBackup) !== EXPECT_COUNT) die(`the backup holds ${inBackup} of the ${EXPECT_COUNT} rows — it is not a usable pre-delete copy`);
console.log('');

// ── Delete ─────────────────────────────────────────────────────────────────
console.log('── delete ───────────────────────────────────────────────────');
let deleted = 0;
try {
  db.transaction(() => {
    // The same verification again, now inside the transaction, so a row that
    // gained a line item, a customer or a stock movement between the survey
    // above and this statement takes the whole thing back.
    for (const fid of FOOD_IDS) {
      const c = verifyOne(fid);
      if (!c.row || c.problems.length) {
        throw new Error(`re-check inside the transaction failed for ${fid}: ${(c.problems || []).join('; ') || 'row vanished'}`);
      }
      if (!targets.includes(c.row.id)) throw new Error(`${fid} now resolves to id ${c.row.id}, which was not in the verified set`);
    }
    const info = db.prepare(`
      DELETE FROM retail_orders
       WHERE id IN (SELECT i.retail_order_id FROM eleme_order_import i
                     WHERE i.eleme_order_id IN (${FOOD_IDS.map(() => '?').join(',')}))
         AND channel = 'eleme'
    `).run(...FOOD_IDS);
    if (info.changes !== EXPECT_COUNT) {
      throw new Error(`DELETE changed ${info.changes} row(s), expected exactly ${EXPECT_COUNT} — rolling back`);
    }
    deleted = info.changes;
  })();
} catch (e) { die(`${e.message}\n        The transaction was rolled back. Backup kept at ${DEST}`); }
console.log(`   deleted ${deleted} row(s) from retail_orders\n`);

// ── Totals after ───────────────────────────────────────────────────────────
const afterAll = totals();
const afterWin = windowTotals();
console.log('── after ────────────────────────────────────────────────────');
console.log(`   eleme rows, 30 Aug – 1 Sep : count=${afterWin.n}  SUM(total)=${r2(afterWin.total)}  SUM(subtotal)=${r2(afterWin.subtotal)}`);
console.log(`   eleme rows, all time       : count=${afterAll.n}  SUM(total)=${r2(afterAll.total)}  SUM(subtotal)=${r2(afterAll.subtotal)}`);
console.log(`   delta (window)             : count ${afterWin.n - beforeWin.n}  total ${r2(afterWin.total - beforeWin.total)}  subtotal ${r2(afterWin.subtotal - beforeWin.subtotal)}`);
console.log('');

// ── What survived, on purpose ──────────────────────────────────────────────
console.log('── kept, deliberately ───────────────────────────────────────');
const imp = db.prepare(`
  SELECT eleme_order_id, retail_order_id, status FROM eleme_order_import
   WHERE eleme_order_id IN (${FOOD_IDS.map(() => '?').join(',')}) ORDER BY id
`).all(...FOOD_IDS);
for (const r of imp) {
  console.log(`   eleme_order_import ${r.eleme_order_id}: retail_order_id=${r.retail_order_id === null ? 'NULL (tombstone, as intended)' : r.retail_order_id + ' — EXPECTED NULL'}  status=${r.status}`);
}
const logN = db.prepare(`SELECT COUNT(*) AS n FROM eleme_sync_log WHERE ${FOOD_IDS.map(() => 'detail LIKE ?').join(' OR ')}`)
  .get(...FOOD_IDS.map(f => '%' + f + '%')).n;
console.log(`   eleme_sync_log rows mentioning these ids: ${logN} (kept — append-only incident record)`);
console.log('');

// The two real orders, checked rather than assumed.
console.log('── the two real orders, unchanged ───────────────────────────');
for (const id of PROTECTED_IDS) {
  const r = db.prepare('SELECT id, order_no, subtotal, total, (SELECT COUNT(*) FROM retail_order_items WHERE order_id = retail_orders.id) AS lines FROM retail_orders WHERE id = ?').get(id);
  console.log(`   id ${id}: ${r ? `${r.order_no} subtotal=${r.subtotal} total=${r.total} lines=${r.lines}` : '*** MISSING — investigate ***'}`);
}
console.log(`\nDone. Backup: ${DEST}`);
