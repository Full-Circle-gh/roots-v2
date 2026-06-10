#!/usr/bin/env node
/**
 * Seed the phone-less ("unmatched") OUT1N migration credits into
 * retail_migration_unmatched. These have no phone (and no obtainable openid),
 * so they can't auto-claim — an operator credits them by hand later.
 *
 * Idempotent: upserts by uid, never touches an already-credited row. Data file
 * is PII-light (uid/name/balance/points, no phone) but still transferred
 * out-of-band and gitignored.
 *
 * Usage (on the server):
 *   node scripts/seed_migration_unmatched.js --dry-run
 *   node scripts/seed_migration_unmatched.js
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const DB_PATH   = path.join(__dirname, '..', 'data', 'roots.db');
const DATA_PATH = path.join(__dirname, '..', 'migration_unmatched.json');

if (!fs.existsSync(DATA_PATH)) { console.error(`[seed] not found: ${DATA_PATH}`); process.exit(1); }
const rows = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
console.log(`[seed] loaded ${rows.length} records · mode: ${DRY ? 'DRY-RUN' : 'APPLY'}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_migration_unmatched (
    uid TEXT PRIMARY KEY, name TEXT, balance REAL NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0, credited_at DATETIME,
    credited_customer_id INTEGER, note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const upsert = db.prepare(`
  INSERT INTO retail_migration_unmatched (uid, name, balance, points)
  VALUES (@uid, @name, @balance, @points)
  ON CONFLICT(uid) DO UPDATE SET
    name = excluded.name, balance = excluded.balance, points = excluded.points
  WHERE retail_migration_unmatched.credited_at IS NULL
`);

const clean = rows.map(r => ({
  uid: String(r.uid), name: r.name ? String(r.name).slice(0, 100) : null,
  balance: Number(r.balance) || 0, points: parseInt(r.points, 10) || 0,
}));

if (!DRY) { const tx = db.transaction(list => { for (const r of list) upsert.run(r); }); tx(clean); }

const t = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(balance),0) b, COALESCE(SUM(points),0) p FROM retail_migration_unmatched').get();
const credited = db.prepare('SELECT COUNT(*) n FROM retail_migration_unmatched WHERE credited_at IS NOT NULL').get().n;
console.log('─'.repeat(46));
console.log('prepared      :', clean.length, `(¥${clean.reduce((s,r)=>s+r.balance,0).toFixed(2)} / ${clean.reduce((s,r)=>s+r.points,0)} pts)`);
console.log('table total   :', t.n, `(¥${Number(t.b).toFixed(2)} / ${t.p} pts)`);
console.log('  credited    :', credited);
console.log(DRY ? '\n[seed] DRY-RUN — no writes.' : '\n[seed] APPLIED.');
db.close();
