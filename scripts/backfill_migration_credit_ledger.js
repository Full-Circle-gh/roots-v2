#!/usr/bin/env node
/**
 * One-off backfill: write the missing wallet ledger row for every customer whose
 * balance was credited by claimMigrationCredit before the writer fix landed.
 *
 *   node scripts/backfill_migration_credit_ledger.js --db <path>           # dry run
 *   node scripts/backfill_migration_credit_ledger.js --db <path> --apply   # write
 *
 * Default --db is data/roots.db. DRY RUN IS THE DEFAULT AND ALWAYS WILL BE.
 *
 * ── WHAT IS WRONG, IN ONE SENTENCE ────────────────────────────────────────
 * THE BALANCE IS CORRECT; THE LEDGER IS INCOMPLETE. Nobody is short a fen. What
 * is missing is the row that explains where the money came from — so this script
 * INSERTS ONLY. It never UPDATEs, never DELETEs, and never touches
 * retail_customers. If you find yourself editing it to change a balance, stop:
 * that is a different script solving a different problem, and this one's proofs
 * are built to reject exactly that.
 *
 * ── THE CAUSE ─────────────────────────────────────────────────────────────
 * `claimMigrationCredit` credited retail_customers.balance and wrote no ledger
 * row, while eleven lines later the points half wrote its retail_points_
 * transactions row. One function, one transaction, one half audited. Fixed for
 * FUTURE claims at 225aa130; this repairs the ones already taken.
 *
 * ── THIS SCRIPT IS THE FIRST THING EVER TO WRITE A `migration:` KEY ─────────
 * READ THIS BEFORE TRUSTING CHECK J. The writer fix shipped on 2026-08-13 and
 * as of 2026-08-16 had never run on a money-carrying claim: three credits were
 * claimed in that window and all three carried a zero balance, so
 * retail_topup_transactions holds ZERO rows with payment_method='migration'.
 *
 * J (no duplicate out_trade_no) therefore currently passes against an EMPTY set.
 * That is not evidence the key scheme works — it is the absence of evidence.
 * These seven rows are the first real population the scheme has ever had, so
 * **J AFTER THIS BACKFILL IS THE SCHEME'S FIRST GENUINE TEST**, and a J failure
 * here would be a finding about the scheme rather than about the data.
 *
 * ── THE KEY SCHEME, AND THE ONE ROW THAT CANNOT USE IT ─────────────────────
 * The writer mints `migration:<credit.id>:<customerId>`. Six of the seven can
 * reproduce that exactly, because their retail_migration_credits row survives
 * and still points at them.
 *
 * The seventh cannot, and the reason is a defect rather than an inconvenience.
 * Its roster row was OVERWRITTEN by a re-import (§24, the migration credits
 * staging table is not append-only): the row was rewritten in place, claimed_at
 * was reset, and a second customer claimed the refreshed credit. So this
 * customer's credit id is not merely unknown — it is unrecoverable, and the
 * amount that was credited to them exists nowhere in the staging table any more.
 * They take their AMOUNT from the measured drift and their DATE from the
 * surviving migration points row, and their key is `migration:unknown:<id>`,
 * which the writer can never mint because credit.id is always an integer.
 *
 * ── THE UNDO IS AN ID LIST, NEVER A PREDICATE ─────────────────────────────
 * --apply writes the inserted ids to a JSON file beside the database. That file
 * IS the undo. Do not undo by `WHERE payment_method='migration'` or by key
 * prefix: real claims now write the same payment_method and the same prefix, so
 * a predicate delete would take live rows with it. The id list cannot.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Arguments ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dbFlagAt = argv.indexOf('--db');
if (dbFlagAt !== -1 && !argv[dbFlagAt + 1]) {
  console.error('[backfill] --db needs a path argument.');
  process.exit(2);
}
const dbPath = dbFlagAt !== -1
  ? path.resolve(argv[dbFlagAt + 1])
  : path.join(__dirname, '..', 'data', 'roots.db');

if (!fs.existsSync(dbPath)) { console.error('[backfill] database not found at', dbPath); process.exit(2); }

const UNDO_PATH = path.join(path.dirname(dbPath), 'backfill_migration_credit_ledger.undo.json');

const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: !APPLY });

const MONEY_EPS = 0.005;
const AUTHORITY = 'scripts/check_ledger_invariants.js check F';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

console.log('');
console.log('backfill_migration_credit_ledger');
console.log('  database: ' + dbPath);
console.log('  mode:     ' + (APPLY ? 'APPLY (writing)' : 'DRY RUN (read-only)'));
if (APPLY && dbPath.replace(/\\/g, '/').endsWith('/roots-v2/data/roots.db')) {
  console.log('');
  console.log('  *** THIS IS THE LIVE PRODUCTION DATABASE ***');
}
console.log('');

// ── Baselines, re-derived NOW rather than hardcoded ───────────────────────
// Proof 3 compares against these. A hardcoded baseline proves the script agrees
// with a number someone typed, which is not the same as agreeing with the data.
function checksum(sql) {
  const rows = db.prepare(sql).all();
  return { sha: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'), n: rows.length };
}
// The two tables that must NOT move, and why each one is here:
//   retail_customers            — F could be made to pass by LOWERING a balance
//   retail_points_transactions  — G could be made to pass by REWRITING a row
// F == 0 alone is satisfiable by cheating. F == 0 with both of these unmoved is
// only satisfiable by inserting into the wallet ledger, which is the point.
const CUSTOMERS_SQL = 'SELECT id, balance, points_balance, lifetime_spend, tier_key FROM retail_customers ORDER BY id';
const POINTS_SQL = `SELECT id, customer_id, delta, balance_after, source, order_id, note, expires_at, created_at
                      FROM retail_points_transactions ORDER BY id`;

const before = {
  customers: checksum(CUSTOMERS_SQL),
  points: checksum(POINTS_SQL),
  topupRows: db.prepare('SELECT COUNT(*) AS n FROM retail_topup_transactions').get().n,
  migrationRows: db.prepare("SELECT COUNT(*) AS n FROM retail_topup_transactions WHERE payment_method = 'migration'").get().n,
};

console.log('BASELINE (re-derived from this database, not hardcoded)');
console.log('  retail_topup_transactions rows:            ' + before.topupRows);
console.log("  of those, payment_method='migration':      " + before.migrationRows +
            (before.migrationRows === 0 ? '   <- the key scheme has never been exercised' : ''));
console.log('  retail_customers checksum:                 ' + before.customers.sha.slice(0, 16) + '…  (' + before.customers.n + ' rows)');
console.log('  retail_points_transactions checksum:       ' + before.points.sha.slice(0, 16) + '…  (' + before.points.n + ' rows)');
console.log('');

// ── Derive the population: check F, run here rather than trusted ──────────
// Same predicate as check_ledger_invariants.js F. Deriving it live means the
// script repairs what is actually broken at the moment it runs, not what was
// broken when it was written.
const failures = db.prepare(`
  SELECT cmp.cid AS customer_id, cmp.bal AS balance, cmp.led AS ledger_sum,
         ROUND(cmp.bal - cmp.led, 2) AS drift
    FROM (
      SELECT c.id AS cid,
             COALESCE(c.balance, 0) AS bal,
             (SELECT COALESCE(SUM(tt.amount), 0)
                FROM retail_topup_transactions tt
               WHERE tt.customer_id = c.id AND tt.status = 'success') AS led
        FROM retail_customers c
    ) AS cmp
   WHERE ABS(cmp.bal - cmp.led) > ?
   ORDER BY cmp.cid`).all(MONEY_EPS);

if (!failures.length) {
  console.log('Check F returns zero — nothing to repair. Exiting without writing.');
  process.exit(0);
}

// ── Build one row per failing customer ────────────────────────────────────
// SELECT ON balance > 0, NEVER ON claimed_at alone. The staging table holds
// 3,265 zero-balance rows; a claimed_at-only predicate picks them all up and
// none of them can ever move a wallet.
const creditFor = db.prepare(`
  SELECT id, balance, points, claimed_at, source_uid
    FROM retail_migration_credits
   WHERE claimed_customer_id = ? AND balance > 0
   ORDER BY id`);
const migrationPointsRow = db.prepare(`
  SELECT id, created_at FROM retail_points_transactions
   WHERE customer_id = ? AND source = 'migration'
   ORDER BY id LIMIT 1`);

const repairedAt = new Date().toISOString();
const planned = [];
const problems = [];

for (const f of failures) {
  const credit = creditFor.get(f.customer_id);
  if (credit) {
    if (Math.abs(round2(credit.balance) - round2(f.drift)) > MONEY_EPS) {
      problems.push(`customer ${f.customer_id}: staging balance ¥${credit.balance} does not match measured drift ¥${f.drift}`);
      continue;
    }
    planned.push({
      customer_id: f.customer_id,
      amount: round2(credit.balance),
      when: credit.claimed_at,
      out_trade_no: `migration:${credit.id}:${f.customer_id}`,
      meta: {
        backfill: true,
        repaired_at: repairedAt,
        authority: AUTHORITY,
        credit_id: credit.id,
        source_uid: credit.source_uid || null,
        amount_source: 'retail_migration_credits.balance',
        date_source: 'retail_migration_credits.claimed_at',
      },
    });
    continue;
  }

  // No surviving staging row. The amount and the date both have to come from
  // elsewhere, and the comment says WHY rather than treating it as a shortcut:
  // the roster row was overwritten by a re-import that reset claimed_at on an
  // already-claimed row (§24 — the staging table is not append-only). That is a
  // DEFECT's cost, not a convenience. The amount is the measured drift because
  // the figure exists nowhere else; the date is the surviving migration points
  // row, which is the only artefact of the claim that the re-import did not
  // touch.
  const pt = migrationPointsRow.get(f.customer_id);
  if (!pt) {
    problems.push(`customer ${f.customer_id}: no staging row AND no migration points row — cannot date the repair`);
    continue;
  }
  planned.push({
    customer_id: f.customer_id,
    amount: round2(f.drift),
    when: pt.created_at,
    out_trade_no: `migration:unknown:${f.customer_id}`,
    meta: {
      backfill: true,
      repaired_at: repairedAt,
      authority: AUTHORITY,
      credit_id: null,
      amount_source: 'measured drift (check F) — staging row overwritten by re-import',
      date_source: `retail_points_transactions.created_at (row ${pt.id})`,
      note: 'roster row overwritten before this repair; credit id unrecoverable. See decisions section 24, the migration credits staging table is not append-only.',
    },
  });
}

console.log('PLANNED ROWS (' + planned.length + ')');
console.log('');
console.log('  customer  amount     paid_at / created_at   out_trade_no                 source');
console.log('  --------  ---------  ---------------------  ---------------------------  ------');
for (const p of planned) {
  console.log('  ' + String(p.customer_id).padEnd(8) +
    ('¥' + p.amount.toFixed(2)).padEnd(10) +
    String(p.when || '(null)').padEnd(23) +
    p.out_trade_no.padEnd(29) +
    (p.meta.credit_id === null ? 'measured drift' : 'staging #' + p.meta.credit_id));
}
console.log('');
console.log('  total: ¥' + planned.reduce((s, p) => s + p.amount, 0).toFixed(2));
console.log('');

if (problems.length) {
  console.log('REFUSING TO PROCEED — ' + problems.length + ' row(s) could not be derived:');
  for (const p of problems) console.log('  ' + p);
  console.log('');
  process.exit(1);
}

if (!APPLY) {
  console.log('DRY RUN — nothing written. Re-run with --apply to write.');
  console.log('');
  process.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────────
if (fs.existsSync(UNDO_PATH)) {
  console.error('[backfill] an undo file already exists at ' + UNDO_PATH);
  console.error('[backfill] refusing to run: a second apply would overwrite the record of the first.');
  process.exit(1);
}

const insert = db.prepare(`
  INSERT INTO retail_topup_transactions
    (customer_id, package_id, amount, bonus_points, payment_method, status,
     out_trade_no, transaction_id, raw_callback_json, created_at, paid_at)
  VALUES (?, NULL, ?, 0, 'migration', 'success', ?, NULL, ?, ?, ?)`);

const insertedIds = [];
db.transaction(() => {
  for (const p of planned) {
    const info = insert.run(p.customer_id, p.amount, p.out_trade_no,
                            JSON.stringify(p.meta), p.when, p.when);
    insertedIds.push(Number(info.lastInsertRowid));
  }
})();

console.log('INSERTED ' + insertedIds.length + ' rows: ' + insertedIds.join(', '));

fs.writeFileSync(UNDO_PATH, JSON.stringify({
  script: 'backfill_migration_credit_ledger.js',
  database: dbPath,
  repaired_at: repairedAt,
  authority: AUTHORITY,
  inserted_ids: insertedIds,
  rows: planned.map((p, i) => ({ id: insertedIds[i], ...p })),
  undo: 'DELETE FROM retail_topup_transactions WHERE id IN (' + insertedIds.join(', ') + ');',
  undo_warning: 'Undo BY ID ONLY. Never by payment_method or key prefix — live claims now write both.',
}, null, 2));
console.log('undo file: ' + UNDO_PATH);
console.log('');

// ── The proofs ────────────────────────────────────────────────────────────
const after = {
  customers: checksum(CUSTOMERS_SQL),
  points: checksum(POINTS_SQL),
  topupRows: db.prepare('SELECT COUNT(*) AS n FROM retail_topup_transactions').get().n,
  migrationRows: db.prepare("SELECT COUNT(*) AS n FROM retail_topup_transactions WHERE payment_method = 'migration'").get().n,
};
const fAfter = db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT COALESCE(c.balance, 0) AS bal,
           (SELECT COALESCE(SUM(tt.amount), 0) FROM retail_topup_transactions tt
             WHERE tt.customer_id = c.id AND tt.status = 'success') AS led
      FROM retail_customers c) AS cmp
   WHERE ABS(cmp.bal - cmp.led) > ?`).get(MONEY_EPS).n;
const flagged = db.prepare(`
  SELECT COUNT(*) AS n FROM retail_topup_transactions
   WHERE payment_method = 'migration'
     AND out_trade_no LIKE 'migration:%'
     AND raw_callback_json LIKE '%"backfill":true%'`).get().n;

const checks = [
  ['3. topup rows +7 exactly (baseline re-derived, not hardcoded)',
   after.topupRows - before.topupRows === planned.length,
   `${before.topupRows} -> ${after.topupRows}  (+${after.topupRows - before.topupRows})`],
  ['4a. retail_customers checksum UNMOVED',
   after.customers.sha === before.customers.sha,
   after.customers.sha === before.customers.sha ? 'identical' : 'MOVED — a balance was altered'],
  ['4b. retail_points_transactions checksum UNMOVED',
   after.points.sha === before.points.sha,
   after.points.sha === before.points.sha ? 'identical' : 'MOVED — a points row was rewritten'],
  ['5. exactly ' + planned.length + ' rows carry the backfill flag AND a migration: key',
   flagged === planned.length, `${flagged} flagged`],
  ['(F re-derived in-process)', fAfter === 0, `F = ${fAfter}`],
];

console.log('PROOFS');
let bad = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + '   ' + detail);
}
console.log('');
console.log('  E, G and J are NOT asserted here — run scripts/check_ledger_invariants.js');
console.log('  against the same database. J is the one to read carefully: before this');
console.log("  run there were " + before.migrationRows + " rows with payment_method='migration', so J's");
console.log("  previous pass was against an empty set. This is its first real test.");
console.log('');
if (bad) { console.error('  ' + bad + ' PROOF(S) FAILED — do not trust this run.'); process.exitCode = 1; }
