#!/usr/bin/env node
/**
 * Seed the one-time OUT1N → roots migration credits.
 *
 * Loads migration_credits.json (an array of { uid, phone, name, balance,
 * points }) and upserts it into retail_migration_credits, keyed by normalized
 * phone. Already-CLAIMED rows are never modified, so re-running is safe and
 * idempotent — a re-seed only refreshes still-unclaimed amounts.
 *
 * The data file holds customer PII (phones + balances) and is intentionally
 * NOT committed to git — scp it to the server next to the repo root, e.g.:
 *   scp migration_credits.json root@47.239.89.63:/root/roots-v2/migration_credits.json
 *
 * Usage (run ON the server, against data/roots.db):
 *   node scripts/seed_migration_credits.js --dry-run     # report only, no writes
 *   node scripts/seed_migration_credits.js               # apply
 *   node scripts/seed_migration_credits.js --file <path> # custom data file
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
const DATA_PATH = fileArg || path.join(__dirname, '..', 'migration_credits.json');

function normalizeMigrationPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2);
  return d;
}

if (!fs.existsSync(DATA_PATH)) {
  console.error(`[seed] data file not found: ${DATA_PATH}`);
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
console.log(`[seed] loaded ${rows.length} records from ${DATA_PATH}`);
console.log(`[seed] mode: ${DRY ? 'DRY-RUN (no writes)' : 'APPLY'}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Ensure the table exists (it's created by database.js at app boot, but this
// lets the seeder run standalone too).
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

const upsert = db.prepare(`
  INSERT INTO retail_migration_credits (phone, balance, points, source_uid, name)
  VALUES (@phone, @balance, @points, @source_uid, @name)
  ON CONFLICT(phone) DO UPDATE SET
    balance    = excluded.balance,
    points     = excluded.points,
    source_uid = excluded.source_uid,
    name       = excluded.name
  WHERE retail_migration_credits.claimed_at IS NULL
`);

let prepared = 0, skippedNoPhone = 0, dupInFile = 0;
const seen = new Set();
const clean = [];
for (const r of rows) {
  const phone = normalizeMigrationPhone(r.phone);
  if (!phone) { skippedNoPhone++; continue; }
  if (seen.has(phone)) { dupInFile++; continue; }
  seen.add(phone);
  clean.push({
    phone,
    balance: Number(r.balance) || 0,
    points: parseInt(r.points, 10) || 0,
    source_uid: r.uid != null ? String(r.uid) : null,
    name: r.name ? String(r.name).slice(0, 100) : null,
  });
  prepared++;
}

const sumBal = clean.reduce((s, r) => s + r.balance, 0);
const sumPts = clean.reduce((s, r) => s + r.points, 0);

if (!DRY) {
  const tx = db.transaction((list) => { for (const r of list) upsert.run(r); });
  tx(clean);
}

const total   = db.prepare('SELECT COUNT(*) n FROM retail_migration_credits').get().n;
const claimed = db.prepare('SELECT COUNT(*) n FROM retail_migration_credits WHERE claimed_at IS NOT NULL').get().n;
const pending = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(balance),0) b, COALESCE(SUM(points),0) p FROM retail_migration_credits WHERE claimed_at IS NULL').get();

console.log('─'.repeat(50));
console.log('records prepared      :', prepared);
console.log('  sum balance         :', sumBal.toFixed(2));
console.log('  sum points          :', sumPts);
console.log('skipped (no phone)    :', skippedNoPhone);
console.log('duplicate phones infile:', dupInFile);
console.log('─'.repeat(50));
console.log('table total rows      :', total);
console.log('  claimed             :', claimed);
console.log('  pending             :', pending.n, `(¥${Number(pending.b).toFixed(2)} / ${pending.p} pts)`);
console.log(DRY ? '\n[seed] DRY-RUN complete — no changes written.' : '\n[seed] APPLIED.');
db.close();
