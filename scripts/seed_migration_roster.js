#!/usr/bin/env node
/**
 * Seed the OUT1N "returning customer" phone roster into retail_migration_credits
 * so the new-customer signup voucher is suppressed for existing OUT1N customers
 * (see reconcileSignupVouchers in routes/retail.js).
 *
 * ADDITIVE-ONLY: uses INSERT OR IGNORE, so a phone that is ALREADY in the table
 * is left completely untouched. This is what protects the 1687 value-holders
 * already seeded by seed_migration_credits.js — their real balance/points are
 * never overwritten. New phones go in as pure roster markers (balance 0,
 * points 0); claimMigrationCredit() no-ops on 0/0 so they credit nothing, they
 * exist only to answer "is this phone a returning OUT1N customer?".
 *
 * Input: migration_roster.json (array of { phone, uid, name }) from
 * build_migration_roster.js. PII → NOT committed; scp it next to the repo root:
 *   scp migration_roster.json root@47.239.89.63:/root/roots-v2/migration_roster.json
 *
 * Usage (run ON the server, against data/roots.db):
 *   node scripts/seed_migration_roster.js --dry-run    # report only, no writes
 *   node scripts/seed_migration_roster.js              # apply
 *   node scripts/seed_migration_roster.js --file <path>
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const fileArg = (() => {
  const i = process.argv.indexOf('--file');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

const DB_PATH   = path.join(__dirname, '..', 'data', 'roots.db');
const DATA_PATH = fileArg || path.join(__dirname, '..', 'migration_roster.json');

function normalizeMigrationPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2);
  return d;
}

if (!fs.existsSync(DATA_PATH)) {
  console.error(`[roster-seed] data file not found: ${DATA_PATH}`);
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
console.log(`[roster-seed] loaded ${rows.length} records from ${DATA_PATH}`);
console.log(`[roster-seed] mode: ${DRY ? 'DRY-RUN (no writes)' : 'APPLY'}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Table is normally created by database.js at boot; ensure it exists so this
// can run standalone too.
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_migration_credits (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    phone               TEXT NOT NULL UNIQUE,
    balance             REAL NOT NULL DEFAULT 0,
    points              INTEGER NOT NULL DEFAULT 0,
    source_uid          TEXT,
    name                TEXT,
    claimed_at          DATETIME,
    claimed_customer_id INTEGER,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// INSERT OR IGNORE — never overwrites an existing (value-holder) row.
const ins = db.prepare(`
  INSERT OR IGNORE INTO retail_migration_credits (phone, balance, points, source_uid, name)
  VALUES (@phone, 0, 0, @source_uid, @name)
`);

const before = db.prepare('SELECT COUNT(*) n FROM retail_migration_credits').get().n;

let prepared = 0, skippedNoPhone = 0, dupInFile = 0, inserted = 0;
const seen = new Set();
const clean = [];
for (const r of rows) {
  const phone = normalizeMigrationPhone(r.phone);
  if (!phone) { skippedNoPhone++; continue; }
  if (seen.has(phone)) { dupInFile++; continue; }
  seen.add(phone);
  clean.push({
    phone,
    source_uid: r.uid != null ? String(r.uid) : null,
    name: r.name ? String(r.name).slice(0, 100) : null,
  });
  prepared++;
}

if (!DRY) {
  const tx = db.transaction((list) => {
    for (const r of list) { const info = ins.run(r); if (info.changes) inserted++; }
  });
  tx(clean);
}

const after   = db.prepare('SELECT COUNT(*) n FROM retail_migration_credits').get().n;
const valHold = db.prepare('SELECT COUNT(*) n FROM retail_migration_credits WHERE balance > 0 OR points > 0').get().n;

console.log('─'.repeat(50));
console.log('records prepared     :', prepared);
console.log('skipped (no phone)   :', skippedNoPhone);
console.log('duplicate phones file:', dupInFile);
console.log('table rows before    :', before);
if (!DRY) {
  console.log('newly inserted (0/0) :', inserted);
  console.log('already present (kept):', prepared - inserted);
}
console.log('table rows after     :', after);
console.log('value-holders (>0)   :', valHold, '(must stay = 1687)');
console.log(DRY ? '\n[roster-seed] DRY-RUN complete — no changes written.' : '\n[roster-seed] APPLIED.');
db.close();
