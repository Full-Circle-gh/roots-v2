#!/usr/bin/env node
//
// backfill_migration_credit_ledger.js — write the seven rows check F is missing.
//
// claimMigrationCredit credited a customer's wallet and wrote no ledger row.
// The WRITER was fixed on 2026-08-13 (225aa13) and every claim since carries its
// row, so the failing set is CLOSED and cannot grow. This writes the rows for the
// seven who claimed BEFORE that fix. Decisions §24 THE FIRST LIVE MONEY
// INCONSISTENCY FOUND BY MEASUREMENT; status doc item 42, remaining half.
//
// ── THE ONE THING THIS SCRIPT MUST NOT DO ────────────────────────────────
// IT DOES NOT TOUCH ANY BALANCE. Not one UPDATE against retail_customers.
//
// The money is ALREADY in the wallet and ¥594.45 of it has already been spent.
// What is missing is the row that EXPLAINS it. Crediting the balance here would
// hand seven customers a second copy of money they already hold — ¥3,669.64 of
// real liability created by a script whose job was bookkeeping. Check F compares
// balance against the ledger sum: the ledger side is short, so the ledger side is
// the side that moves. If you are editing this file and reach for
// `UPDATE retail_customers SET balance`, stop; you have misread the defect.
//
// ── THE SEVEN, AND WHERE THE FIGURES COME FROM ───────────────────────────
// Measured 2026-08-13 against the 10:00 hourly and reproduced byte-for-byte
// against the 15:00 (§24 v4.36, v4.37). `unexplained` is balance − ledger_sum,
// which is exactly what F reports as `drift` and exactly what must be written to
// make F return zero: writing amount D moves the ledger sum from L to L+D, and F
// passes when balance == L+D, i.e. when D == balance − L.
//
//   customer   balance   ledger sum   unexplained   staging balance
//        57      9.99          0.00          9.99   — row overwritten, ORPHAN
//        92    885.00          0.00        885.00   885.00
//       161      0.00       −394.95        394.95   394.95
//       306     98.40          0.00         98.40    98.40
//       416    196.50       −199.50        396.00   396.00
//       693    143.80          0.00        143.80   143.80
//       814   1741.50          0.00       1741.50   1741.50
//                                       ─────────
//                                        3,669.64
//
// 161 and 416 hold a NEGATIVE ledger sum: credited silently, then spent with only
// the spend recorded. They are not a different defect and need no special case —
// their drift is still balance − ledger_sum and the same single row closes it.
//
// ── CUSTOMER 57 IS NOT A CUSTOMER, AND NEEDS ITS OWN FLAG ────────────────
// 57 is `_reset_1781343070821_oeqDi5KI8…`, an archived row left by
// /api/retail-admin/customers/:id/reset-test. Six of the seven are real people;
// the ¥9.99 is ours (§24 v4.37). It is included because F counts it and Part G
// cannot expect ALL 10 PASSED while it fails — but it is the ONE target whose
// amount CANNOT be corroborated against retail_migration_credits, because the
// re-import that overwrote row 1516 took its value with it (§24 THE MIGRATION
// CREDITS STAGING TABLE IS NOT APPEND-ONLY). Every other target is checked
// against two independent sources and agrees on both. That one is checked
// against one. So it requires --include-orphan, explicitly, every run.
//
// The alternative for 57 — zeroing its balance instead of explaining it — is
// deliberately NOT offered. It destroys data on a row nobody owns, on the one
// target whose provenance is already damaged, and it is not reversible by
// deleting a row. Additive and undoable beats tidy.
//
// ── WHAT IT WRITES, AND WHY IN EXACTLY THAT SHAPE ────────────────────────
// The row is byte-for-byte the shape the FIXED writer produces, so a backfilled
// row and a row written by claimMigrationCredit today are indistinguishable to
// every reader — which is the point. Same table, same payment_method, same
// status, same bonus_points, same out_trade_no scheme.
//
//   out_trade_no = `migration:<creditId>:<customerId>`   (the six)
//                = `migration:orphan:<customerId>`       (57, no credit row)
//
// THE KEY CARRIES THE CLAIMANT AND NOT JUST THE CREDIT, and that is load-bearing
// rather than decorative. Keyed on credit.id alone it collides the moment a
// re-armed staging row is claimed by a SECOND customer — which has already
// happened once — and check J would report two legitimate credits as a duplicate.
// With the claimant in the key that case is distinct, and the one case that DOES
// collide (the same customer credited twice from one credit row) is a real double
// credit that J SHOULD report. Using the live writer's scheme verbatim preserves
// that property for these rows too.
//
//   bonus_points = 0, deliberately. The points half of each claim already wrote
//   its retail_points_transactions row and check E sums that; repeating the count
//   here would be a second record of one event with nothing tying the two
//   together. The figure rides in raw_callback_json, where it explains without
//   counting.
//
//   paid_at  = the staging row's claimed_at — when the money actually moved.
//   created_at = now, by column default — when this row was written.
//   The asymmetry is the audit trail and is not an oversight. Do not "fix" it.
//
// ── SAFETY ───────────────────────────────────────────────────────────────
//   • DRY RUN BY DEFAULT. --apply is required to write, and it fails closed.
//   • The targets are a FIXED LIST, not a query. A query for "who fails F" would
//     also sweep up anything a future defect creates, and this script's
//     justification — seven customers, measured, on one path fixed on
//     2026-08-13 — would not extend to it.
//   • Every target is re-checked against BOTH sources at plan time and AGAIN
//     inside the transaction, on the same precondition, never a weaker one.
//   • A target whose drift has MOVED is refused, not adjusted. Moved drift means
//     the world changed since the measurement and a human should look.
//   • Idempotent: a target that already carries its row is skipped, not doubled.
//   • Checksums before and after. An UNDO FILE written before the commit.
//
// ── ACCEPTANCE TEST — not this script's own output ───────────────────────
//   node scripts/check_ledger_invariants.js
// Run it BEFORE and AFTER. F must go from 7 failing customers to 0, and NOTHING
// ELSE MAY MOVE. The only other invariants this write can reach are J (duplicate
// out_trade_no) and I (orphaned ledger row); both are guarded here, and both must
// still read zero afterwards.
//
// WHEN F IS ZERO, PART G OF THE CUTOVER RUNBOOK LOSES ITS REASON TO EXIST IN ITS
// CURRENT FORM: step D3's baseline and step G6's diff exist ONLY to tolerate this
// defect. Closing it means G6 can expect ALL 10 INVARIANTS PASSED outright. That
// is a documentation change and it is not this script's job, but it is the
// outcome this script is for.
//
// USAGE
//   node scripts/backfill_migration_credit_ledger.js                    # dry run
//   node scripts/backfill_migration_credit_ledger.js --include-orphan   # dry run, all 7
//   node scripts/backfill_migration_credit_ledger.js --include-orphan --apply
//   node scripts/backfill_migration_credit_ledger.js --db <path>        # target a copy
//
// EXIT  0 done (or nothing to do) · 1 refused / failed

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--apply');
const ORPHAN = argv.includes('--include-orphan');
const dbFlag = argv.indexOf('--db');
const DB_PATH = dbFlag >= 0 && argv[dbFlag + 1]
  ? path.resolve(argv[dbFlag + 1])
  : path.join(__dirname, '..', 'data', 'roots.db');

// Same epsilon check_ledger_invariants.js uses, so "agrees with F" means the same
// thing in both files. Money is REAL on this engine and numeric(14,2) on the
// other; neither is exact and both are compared, never equated.
const MONEY_EPS = 0.005;

if (!fs.existsSync(DB_PATH)) { console.error('DB not found at', DB_PATH); process.exit(1); }
const db = new Database(DB_PATH);

// ── the targets, named rather than discovered ────────────────────────────
// `unexplained` is the figure F reported on 2026-08-13. It is the amount to
// write. `staging` is the independent second source; null means "cannot be
// corroborated" and forces the orphan path.
const TARGETS = [
  { customerId: 57,  unexplained:    9.99, staging:    null, orphan: true },
  { customerId: 92,  unexplained:  885.00, staging:  885.00, orphan: false },
  { customerId: 161, unexplained:  394.95, staging:  394.95, orphan: false },
  { customerId: 306, unexplained:   98.40, staging:   98.40, orphan: false },
  { customerId: 416, unexplained:  396.00, staging:  396.00, orphan: false },
  { customerId: 693, unexplained:  143.80, staging:  143.80, orphan: false },
  { customerId: 814, unexplained: 1741.50, staging: 1741.50, orphan: false },
];
const TOTAL_EXPECTED = 3669.64;

const money = (n) => Number(n || 0).toFixed(2);
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const digest = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
const ids = TARGETS.map((t) => t.customerId);

// A guard against editing the table above without re-measuring: the list must
// still add up to the figure the record carries. Someone adding an eighth
// customer or nudging an amount has to confront this line.
const listSum = round2(TARGETS.reduce((s, t) => s + t.unexplained, 0));
if (Math.abs(listSum - TOTAL_EXPECTED) > MONEY_EPS) {
  console.error(`TARGET LIST SUMS TO ¥${money(listSum)}, RECORD SAYS ¥${money(TOTAL_EXPECTED)} — refusing.`);
  console.error('The list was edited without re-measuring. Re-run check F and update §24 first.');
  process.exit(1);
}

// ── the drift F would report, computed the way F computes it ─────────────
function driftFor(customerId) {
  const row = db.prepare(`
    SELECT COALESCE(c.balance, 0) AS bal,
           (SELECT COALESCE(SUM(tt.amount), 0)
              FROM retail_topup_transactions tt
             WHERE tt.customer_id = c.id AND tt.status = 'success') AS led
      FROM retail_customers c WHERE c.id = ?`).get(customerId);
  if (!row) return null;
  return { balance: round2(row.bal), ledger: round2(row.led), drift: round2(row.bal - row.led) };
}

// ── checksum surface: every row this script can touch, and its inputs ─────
function snapshot() {
  const ph = ids.map(() => '?').join(',');
  const customers = db.prepare(
    `SELECT id, balance FROM retail_customers WHERE id IN (${ph}) ORDER BY id`).all(...ids);
  const ledger = db.prepare(
    `SELECT id, customer_id, amount, payment_method, status, out_trade_no, paid_at
       FROM retail_topup_transactions WHERE customer_id IN (${ph}) ORDER BY id`).all(...ids);
  const credits = db.prepare(
    `SELECT id, balance, points, claimed_at, claimed_customer_id
       FROM retail_migration_credits WHERE claimed_customer_id IN (${ph}) ORDER BY id`).all(...ids);
  return { customers, ledger, credits };
}
const stamp = (s) => ({ customers: digest(s.customers), ledger: digest(s.ledger), credits: digest(s.credits) });

// ── plan ─────────────────────────────────────────────────────────────────
const plan = [];
const skipped = [];

for (const t of TARGETS) {
  const tag = `customer ${t.customerId}`;
  const customer = db.prepare('SELECT id, balance FROM retail_customers WHERE id = ?').get(t.customerId);
  if (!customer) { skipped.push(`${tag}: no such customer — refusing`); continue; }

  if (t.orphan && !ORPHAN) {
    skipped.push(`${tag}: ORPHAN (¥${money(t.unexplained)}) — needs --include-orphan; see the header`);
    continue;
  }

  // SOURCE 2 — the staging roster, matched against the RECORDED figure. Resolved
  // first because the out_trade_no is built from it, and the idempotency check
  // needs the key before it can ask whether this already ran. The orphan has no
  // staging row, by definition.
  let credit = null;
  if (!t.orphan) {
    const rows = db.prepare(
      'SELECT id, balance, points, source_uid, claimed_at FROM retail_migration_credits WHERE claimed_customer_id = ? ORDER BY id'
    ).all(t.customerId);
    if (!rows.length) { skipped.push(`${tag}: no claimed staging row — expected one; refusing`); continue; }
    // More than one claimed row is possible and is not an error by itself; the
    // one this defect concerns is the one whose balance matches.
    const matches = rows.filter((r) => Math.abs(round2(r.balance) - t.staging) <= MONEY_EPS);
    if (matches.length !== 1) {
      skipped.push(`${tag}: ${matches.length} staging rows carry ¥${money(t.staging)} (expected exactly 1, saw ${rows.length} claimed) — refusing`);
      continue;
    }
    credit = matches[0];
  }

  const outTradeNo = credit
    ? `migration:${credit.id}:${t.customerId}`
    : `migration:orphan:${t.customerId}`;

  // IDEMPOTENCY FIRST, AND BEFORE THE DRIFT CHECKS ON PURPOSE. Once the row
  // exists the drift is zero, so a drift-first order would report every re-run
  // as "nothing owed" — true, but it is the wrong answer to the question the
  // operator is asking, which is whether THIS script already ran. It also
  // conflates two states that must not be conflated: a row we wrote, and a
  // balance someone explained by other means. Distinguish them here.
  const existing = db.prepare(
    'SELECT id, customer_id, amount, status FROM retail_topup_transactions WHERE out_trade_no = ?').get(outTradeNo);
  if (existing) {
    skipped.push(`${tag}: ${outTradeNo} already exists (row ${existing.id}, ¥${money(existing.amount)}) — already backfilled`);
    continue;
  }

  const m = driftFor(t.customerId);
  if (Math.abs(m.drift) <= MONEY_EPS) {
    skipped.push(`${tag}: drift is zero but ${outTradeNo} does not exist — explained by something else; look before writing`);
    continue;
  }
  // SOURCE 1 — the live measurement. Refuse on any movement rather than writing
  // the new figure: a drift that moved means something happened to this customer
  // since 2026-08-13 that nobody has looked at.
  if (Math.abs(m.drift - t.unexplained) > MONEY_EPS) {
    skipped.push(`${tag}: drift is ¥${money(m.drift)} but the measured figure was ¥${money(t.unexplained)} — data moved, refusing`);
    continue;
  }
  // The two sources must agree with each other, not merely each with the list.
  if (credit && Math.abs(round2(credit.balance) - m.drift) > MONEY_EPS) {
    skipped.push(`${tag}: staging says ¥${money(credit.balance)}, drift says ¥${money(m.drift)} — sources disagree, refusing`);
    continue;
  }

  // paid_at: when the money moved, not when this row was written. The orphan has
  // no claimed_at, so it borrows the timestamp of its own points half — the row
  // written by the same transaction that credited the balance.
  let paidAt = credit && credit.claimed_at ? credit.claimed_at : null;
  let paidAtSource = 'staging claimed_at';
  if (!paidAt) {
    const pts = db.prepare(
      "SELECT created_at FROM retail_points_transactions WHERE customer_id = ? AND source = 'migration' ORDER BY id LIMIT 1"
    ).get(t.customerId);
    paidAt = pts ? pts.created_at : null;
    paidAtSource = pts ? "sibling 'migration' points row" : 'NONE — will be NULL';
  }

  plan.push({ ...t, credit, outTradeNo, paidAt, paidAtSource, measured: m });
}

// ── report ───────────────────────────────────────────────────────────────
const before = snapshot();
console.log('DB:', DB_PATH);
console.log('MODE:', WRITE ? 'APPLY' : 'DRY RUN', ORPHAN ? '· orphan included' : '· orphan excluded');
console.log('\nCHECKSUMS BEFORE');
for (const [k, v] of Object.entries(stamp(before))) console.log(`  ${k.padEnd(10)} ${v}`);

console.log('\nPLAN — ledger rows to write. NO BALANCE IS TOUCHED.');
if (!plan.length) console.log('  (nothing to do)');
for (const p of plan) {
  console.log(`  customer ${String(p.customerId).padStart(3)}: +¥${money(p.unexplained).padStart(8)} ledger row  ${p.outTradeNo}`);
  console.log(`      balance ¥${money(p.measured.balance)} stays put; ledger ¥${money(p.measured.ledger)} -> ¥${money(round2(p.measured.ledger + p.unexplained))}, drift -> ¥0.00`);
  console.log(`      paid_at ${p.paidAt || '(null)'}  [${p.paidAtSource}]`);
}
for (const s of skipped) console.log(`  SKIP  ${s}`);

const planned = round2(plan.reduce((s, p) => s + p.unexplained, 0));
console.log(`\n  ${plan.length} row(s), ¥${money(planned)} of balance explained` +
  (plan.length === TARGETS.length ? ' — the whole finding' : ` of ¥${money(TOTAL_EXPECTED)}`));

if (!plan.length) { console.log('\nNothing to apply.'); process.exit(0); }

if (!WRITE) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
  console.log('Run scripts/check_ledger_invariants.js before AND after, and compare.');
  if (!ORPHAN) console.log('NOTE: customer 57 is excluded. F will still fail on it, and Part G still needs its baseline.');
  process.exit(0);
}

// ── undo file, written BEFORE the transaction commits ────────────────────
const undo = {
  script: 'backfill_migration_credit_ledger.js',
  db: DB_PATH,
  written_at: new Date().toISOString(),
  checksums_before: stamp(before),
  prior_state: before,
  planned: plan.map((p) => ({
    customer_id: p.customerId, amount: p.unexplained, out_trade_no: p.outTradeNo, paid_at: p.paidAt,
  })),
  how_to_undo: [
    'DELETE FROM retail_topup_transactions WHERE out_trade_no IN (the planned out_trade_no values)',
    'AND payment_method = \'migration\'. That is the whole undo — no balance was changed,',
    'so nothing else has to be put back. Verify by re-running check_ledger_invariants.js:',
    'check F should return to 7 failing customers and ¥3,669.64.',
  ],
};
const undoPath = path.join(path.dirname(DB_PATH), `undo-backfill-migration-credit-${Date.now()}.json`);
fs.writeFileSync(undoPath, JSON.stringify(undo, null, 2));
console.log('\nUNDO FILE:', undoPath);

// ── apply ────────────────────────────────────────────────────────────────
let written = 0, amount = 0;
const tx = db.transaction(() => {
  for (const p of plan) {
    // Re-check inside the transaction, on the SAME preconditions the plan used.
    const dup = db.prepare('SELECT id FROM retail_topup_transactions WHERE out_trade_no = ?').get(p.outTradeNo);
    if (dup) continue;
    const m = driftFor(p.customerId);
    if (!m || Math.abs(m.drift - p.unexplained) > MONEY_EPS) continue;

    db.prepare(
      `INSERT INTO retail_topup_transactions
         (customer_id, amount, bonus_points, payment_method, status, paid_at, out_trade_no, raw_callback_json)
       VALUES (?, ?, 0, 'migration', 'success', ?, ?, ?)`
    ).run(
      p.customerId, p.unexplained, p.paidAt, p.outTradeNo,
      JSON.stringify({
        migration_credit_id: p.credit ? p.credit.id : null,
        source_uid: p.credit ? (p.credit.source_uid || null) : null,
        points: p.credit ? (p.credit.points || 0) : 0,
        backfill: true,
        backfill_note: 'row never written by claimMigrationCredit before the 2026-08-13 writer fix (225aa13); balance was already correct and is untouched',
      })
    );
    written++; amount = round2(amount + p.unexplained);
  }
});
tx();

const after = snapshot();
console.log('\nAPPLIED');
console.log(`  ledger rows written: ${written}`);
console.log(`  balance explained:   ¥${money(amount)}`);
console.log('  balances changed:    0 — by design');

console.log('\nCHECKSUMS AFTER');
const sb = stamp(before), sa = stamp(after);
for (const k of Object.keys(sa)) console.log(`  ${k.padEnd(10)} ${sa[k]}${sa[k] === sb[k] ? '  (unchanged)' : '  (was ' + sb[k] + ')'}`);
if (sa.customers !== sb.customers) {
  console.log('\n  *** THE CUSTOMERS CHECKSUM MOVED. This script does not write balances.');
  console.log('  *** Something else did, concurrently. Investigate before trusting the result.');
}

console.log('\nRESIDUAL DRIFT, per target:');
for (const t of TARGETS) {
  const m = driftFor(t.customerId);
  console.log(`  customer ${String(t.customerId).padStart(3)}: ¥${money(m ? m.drift : 0)}`);
}

console.log('\nNOW RUN THE ACCEPTANCE TEST:  node scripts/check_ledger_invariants.js');
console.log('Compare against the run you took before this one.');
console.log('Check F must read 0. Checks I and J must still read 0. Nothing else may move.');
if (!ORPHAN) console.log('Customer 57 was excluded, so F will still report 1 customer and ¥9.99.');
process.exit(0);
