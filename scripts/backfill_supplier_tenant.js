#!/usr/bin/env node
/**
 * Assign every supplier row to a tenant.
 *
 * READ-ONLY BY DEFAULT. Prints what it would do and writes nothing. Pass
 * --apply to write; --apply takes a backup first and runs in ONE transaction.
 *
 *   node scripts/backfill_supplier_tenant.js            # dry run (default)
 *   node scripts/backfill_supplier_tenant.js --apply    # take backup, then write
 *
 * ── READ THIS BEFORE RUNNING IT: IT IS PROBABLY A NO-OP ───────────────────
 * Measured on production 2026-08-24:
 *
 *   suppliers total ............ 234
 *   tenant_id IS NULL .......... 0
 *   tenant_id = 1 (Roots) ...... 234
 *   tenant_id = anything else .. 0
 *
 * The backfill everyone expected to be a precondition had ALREADY HAPPENED,
 * silently, when the column was added. `addColumn('suppliers', 'tenant_id',
 * 'INTEGER DEFAULT 1')` (database.js:351) is an `ALTER TABLE ... ADD COLUMN`
 * with a non-NULL default, and SQLite writes that default into every existing
 * row at ALTER time rather than leaving them NULL.
 *
 * So this script exists for three reasons, none of which is "the rows have no
 * tenant":
 *
 *   1. To PROVE that, on the box, at the moment of running, rather than on the
 *      strength of a measurement taken on a different day.
 *   2. As the repair if a row ever does turn up NULL — an import, a restore
 *      from an older file, a hand-edit.
 *   3. Because the scoping change it accompanies was written to be safe in
 *      either order (every predicate is COALESCE(tenant_id, 1), so a NULL row
 *      reads as Roots' rather than vanishing) — and that claim deserves a
 *      script that can demonstrate the NULL case is empty.
 *
 * ── WHICH TENANT ──────────────────────────────────────────────────────────
 * Roots, tenant 1. Every supplier in this database was created by Roots: there
 * is exactly one row in `tenants` (id 1, "Roots"), the kitchen supplier create
 * never set the column, and the retail one has always stamped currentTenantId()
 * which resolves to 1 for Roots. There is no second tenant to attribute a row
 * to and the script will not guess: if it finds a NULL row while more than one
 * tenant exists, it REFUSES and asks a human, rather than sweeping the row to
 * Roots because Roots is first in the table.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APPLY   = process.argv.includes('--apply');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const ROOTS_TENANT_ID = 1;

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}. Set ROOTS_DB to override.`);
    process.exit(1);
  }
  const db = new Database(DB_PATH, APPLY ? {} : { readonly: true });

  console.log('='.repeat(78));
  console.log(`  Supplier tenant backfill — ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`);
  console.log(`  Database : ${DB_PATH}`);
  console.log('='.repeat(78));

  // ── State of play ────────────────────────────────────────────────────────
  const total   = db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n;
  const nulls   = db.prepare('SELECT COUNT(*) AS n FROM suppliers WHERE tenant_id IS NULL').get().n;
  const byTenant = db.prepare(
    'SELECT COALESCE(tenant_id, -1) AS t, COUNT(*) AS n FROM suppliers GROUP BY 1 ORDER BY 2 DESC'
  ).all();

  let tenants = [];
  try { tenants = db.prepare('SELECT id, name FROM tenants ORDER BY id').all(); } catch (e) { tenants = []; }

  console.log(`\n  suppliers ............ ${total}`);
  console.log(`  tenant_id IS NULL .... ${nulls}`);
  for (const r of byTenant) {
    const label = r.t === -1 ? 'NULL' : `tenant ${r.t}`;
    const name  = tenants.find(t => t.id === r.t);
    console.log(`    ${label.padEnd(12)} ${String(r.n).padStart(5)}${name ? '   (' + name.name + ')' : ''}`);
  }
  console.log(`\n  tenants in this database: ${tenants.length ? tenants.map(t => `${t.id} ${t.name}`).join(', ') : '(none readable)'}`);

  if (nulls === 0) {
    console.log('\n  Nothing to do — every supplier row already carries a tenant.');
    console.log('  This is the expected result. See the header of this file for why.\n');
    db.close();
    return;
  }

  // ── There ARE NULL rows. Refuse to guess if a second tenant exists. ──────
  if (tenants.length > 1) {
    console.error(`\n  ${nulls} supplier row(s) have no tenant, and this database has ${tenants.length} tenants.`);
    console.error('  REFUSING to assign them. With more than one tenant, "which tenant owns this');
    console.error('  row" is a question about the business, and sweeping them to Roots because');
    console.error('  Roots is first in the table would be a guess wearing the clothes of a fix.');
    console.error('\n  The rows needing a decision:\n');
    const rows = db.prepare('SELECT id, name, created_at FROM suppliers WHERE tenant_id IS NULL ORDER BY id').all();
    for (const r of rows) console.error(`    #${r.id}  ${r.name}   (created ${r.created_at || 'unknown'})`);
    console.error('');
    db.close();
    process.exit(1);
  }

  console.log(`\n  ${nulls} supplier row(s) would be assigned to tenant ${ROOTS_TENANT_ID} (Roots):\n`);
  for (const r of db.prepare('SELECT id, name FROM suppliers WHERE tenant_id IS NULL ORDER BY id').all()) {
    console.log(`    #${r.id}  ${r.name}`);
  }

  if (!APPLY) {
    console.log('\n  ' + '-'.repeat(74));
    console.log('  DRY RUN — nothing was written. Re-run with --apply to make these changes.\n');
    db.close();
    return;
  }

  // ── Backup, then one transaction ─────────────────────────────────────────
  const stamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${DB_PATH}.pre-supplier-tenant.${stamp}.bak`;
  console.log(`\n  Backing up to ${backup} …`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB_PATH, backup);
  const size = fs.statSync(backup).size;
  if (size < 1024) {
    console.error(`  Backup is only ${size} bytes — refusing to continue.`);
    db.close();
    process.exit(1);
  }
  console.log(`  Backup written, ${(size / 1048576).toFixed(1)} MB.\n`);

  try {
    db.transaction(() => {
      const r = db.prepare('UPDATE suppliers SET tenant_id = ? WHERE tenant_id IS NULL').run(ROOTS_TENANT_ID);
      if (r.changes !== nulls) {
        throw new Error(`expected to change ${nulls} row(s), changed ${r.changes}. Rolled back.`);
      }
      console.log(`  ${r.changes} row(s) assigned to tenant ${ROOTS_TENANT_ID}.`);
    })();
  } catch (e) {
    console.error(`\n  ROLLED BACK — nothing was written.\n  ${e.message}\n`);
    db.close();
    process.exit(1);
  }

  const left = db.prepare('SELECT COUNT(*) AS n FROM suppliers WHERE tenant_id IS NULL').get().n;
  console.log(`\n  Done. tenant_id IS NULL is now ${left}. Backup: ${backup}\n`);
  db.close();
}

main();
