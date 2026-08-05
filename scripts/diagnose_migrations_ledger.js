#!/usr/bin/env node
/**
 * diagnose_migrations_ledger.js — read the live `_migrations` ledger, in full.
 *
 * WHY THIS EXISTS
 * ---------------
 * database.js runs its one-time migrations AT MODULE LOAD, guarded by a marker row
 * in `_migrations`. Four of those migration bodies write money columns:
 *
 *   database.js:731   packaging_types.cost              guard lookups_seed_v1
 *   database.js:3398  retail_delivery_zones money cols  guard shipping_spec_alignment_v1
 *   database.js:3419  retail_delivery_zones money cols  guard shipping_spec_alignment_v1
 *   database.js:3545  retail_customers.lifetime_spend   guard backfill_lifetime_spend_v1
 *
 * A yuan→cents converter, when one exists, gets installed at some point during
 * startup. Module-load migration DML that runs BEFORE that install writes raw
 * values through an unconverted seam. Whether that matters for these four depends
 * on one fact this session has been treating as an assumption: are their guards
 * already recorded on the live database? If they are, the bodies are dead code on
 * every future boot and the exposure is only from migrations written from now on.
 *
 * WHAT IT DOES
 * ------------
 * Opens the live database read-only, PROVES read-only by attempting a write and
 * aborting if the write is accepted, and prints every row of `_migrations`.
 *
 * It prints the WHOLE table rather than the three names in question. The table is
 * ~144 rows; dumping it costs nothing and means the analysis afterwards is done
 * against the real ledger rather than against a list embedded in this file, which
 * would only be as good as the moment it was written. The three names are called
 * out separately at the end for readability, not as the extent of the read.
 *
 * It writes nothing, restarts nothing, and touches no pm2 process.
 *
 * Run: node scripts/diagnose_migrations_ledger.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const HOME = process.env.ROOTS_HOME || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');
const Database = require(path.join(HOME, 'node_modules', 'better-sqlite3'));

if (!fs.existsSync(DB_PATH)) { console.error('FATAL: no database at ' + DB_PATH); process.exit(2); }

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write.'); process.exit(2); }
console.log('db: ' + DB_PATH);

// The three guards whose bodies write money columns.
const MONEY_GUARDS = [
  'lookups_seed_v1',
  'shipping_spec_alignment_v1',
  'backfill_lifetime_spend_v1',
];

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · does the ledger exist, and what shape is it ══');

const tbl = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_migrations'"
).get();
if (!tbl) {
  console.log('   _migrations DOES NOT EXIST on this database.');
  console.log('   Every guarded migration in database.js would run at the next boot.');
  process.exit(0);
}
console.log('   ' + String(tbl.sql).replace(/\s+/g, ' ').trim());

const cols = db.prepare('PRAGMA table_info(_migrations)').all().map((c) => c.name);
console.log('   columns: ' + cols.join(', '));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · every row, in the order it was applied ══');

const rows = db.prepare(
  'SELECT rowid AS rid, name, applied_at FROM _migrations ORDER BY rowid'
).all();
console.log(`   ${rows.length} row(s)\n`);
for (const r of rows) {
  console.log(`   ${String(r.rid).padStart(4)}  ${String(r.applied_at || '(null)').padEnd(21)}  ${r.name}`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · the three money-writing guards ══');
console.log('   (called out for readability — §2 above is the actual read)');

const have = new Map(rows.map((r) => [r.name, r]));
for (const g of MONEY_GUARDS) {
  const r = have.get(g);
  if (r) console.log(`   RECORDED    ${g.padEnd(30)} applied_at=${r.applied_at || '(null)'}`);
  else   console.log(`   NOT PRESENT ${g.padEnd(30)} — its body would run at the next boot`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · when was the ledger last added to ══');
console.log('   (bears on how fast the set grows between now and cutover)');

const byDate = db.prepare(
  "SELECT substr(COALESCE(applied_at, ''), 1, 10) AS d, COUNT(*) AS n " +
  'FROM _migrations GROUP BY d ORDER BY d'
).all();
for (const r of byDate) console.log(`   ${(r.d || '(null)').padEnd(12)} ${String(r.n).padStart(4)}`);

console.log('\n' + '═'.repeat(72));
console.log('READ COMPLETE — this tool reports and judges nothing.');
process.exit(0);
