#!/usr/bin/env node
require('../lib/load-env').loadEnv();
//
// migrate_money.js — rung 1 of the money ladder (audit A-06, Stage 2 of
// docs/tacet-money-migration-plan.md).
//
// WHAT THIS RUNG DOES, AND WHAT IT DELIBERATELY DOES NOT
// ------------------------------------------------------
// It adds an integer column beside each REAL money column and fills it in.
// That is all. Nothing reads the new column, nothing writes it at runtime, and
// the REAL column is untouched — so the application after this migration
// behaves exactly as it did before it, byte for byte, and rolling back is
// dropping a column nobody uses.
//
// The tempting version is to convert every column, flip every reader and ship
// once. That is refused, for one specific reason: A CENTS COLUMN READ AS YUAN
// IS A 100× ERROR. In a refund that is catastrophic and obvious. In a report it
// is catastrophic and NOT obvious — it looks like a good month. So the design
// goal here is not "convert correctly", it is "make a missed reader impossible
// to miss", and that is what the five rungs buy:
//
//   1  add + backfill        ← this file. Nothing reads it. Reversible.
//   2  dual-write            every writer writes both. Ship and let it run.
//   3  shadow-check          a sweep asserting the two agree, reporting through
//                            the notification log. A divergence IS a writer that
//                            was missed, found before anything depends on it.
//   4  flip readers          a missed reader is now STALE, not wrong by 100×.
//   5  drop the REAL column  the only irreversible one, after a clean window.
//
// AMOUNTS AND RATES GET DIFFERENT SCALES, and this is the thing that would be
// easiest to get wrong and most expensive to have got wrong. An amount goes to
// cents; a RATE goes to ten-thousandths, because `ingredients.cost_per_unit` is
// 0.042 yuan per gram, which is 4.2 cents, and rounding it to 4 moves the cost
// basis of every recipe by 5%. lib/money-columns.js holds which is which and
// this file refuses to guess.
//
// IT WILL NOT TOUCH AN UNRESOLVED COLUMN. Four columns have no settled unit —
// retail_vouchers.value holds a PERCENTAGE for percent coupons — and converting
// one on a guess is the failure the inventory exists to prevent.
//
// USAGE
//   node scripts/migrate_money.js --db <copy>                 what it would do
//   node scripts/migrate_money.js --db <copy> --apply         do it
//   node scripts/migrate_money.js --db <copy> --verify        prove it landed
//   node scripts/migrate_money.js --db <copy> --rollback      drop the new columns
//   …--family refunds|orders|customers|purchasing|all         default: refunds
//
// NEVER DEFAULTS TO PRODUCTION. --db is required, unlike the read-only checkers
// which can safely default. A migration that runs somewhere nobody named is the
// one mistake this script must not make possible.
//
// EXIT CODE
//   0  did what was asked, and it verified
//   1  something did not verify
//   2  it could not run

'use strict';

const fs = require('fs');
const moneyColumns = require('../lib/money-columns');

// The order is the plan's, and it is by CONSEQUENCE rather than by size: the
// refund columns first because that is where the half-cent tolerance decides a
// real refund to a real customer, and they are the smallest blast radius.
const FAMILIES = {
  refunds: [
    'retail_payments.amount', 'retail_payments.refunded_amount',
    'retail_orders.refund_amount_requested', 'retail_orders.refund_amount_approved',
    'retail_orders.refund_amount_paid', 'retail_orders.refund_cash_amount',
  ],
  orders: [
    'retail_orders.subtotal', 'retail_orders.shipping_fee', 'retail_orders.packing_fee',
    'retail_orders.same_day_surcharge_fee', 'retail_orders.voucher_amount',
    'retail_orders.points_amount', 'retail_orders.balance_used', 'retail_orders.total',
    'retail_order_items.line_total', 'retail_order_items.unit_cost_at_sale',
    'retail_order_addons.amount', 'retail_order_addons.addon_subtotal',
    'retail_refund_events.amount',
  ],
  customers: [
    'retail_customers.lifetime_spend', 'retail_customers.balance',
    'retail_topup_transactions.amount', 'retail_migration_credits.balance',
    'retail_referrals.reward_amount', 'retail_referrals.referee_reward_amount',
  ],
  purchasing: [
    'po_line_items.cost_per_unit', 'po_line_items.total_cost',
    'ingredients.cost_per_unit', 'ingredients.buy_price',
    'ingredient_price_history.price', 'store_products.unit_cost',
    'expense_entries.amount', 'income_entries.amount',
  ],
};
// `all` is EVERY classified column, not the union of the four lists above. The
// difference matters: the four are hand-ordered by consequence and do not
// mention the unresolved columns at all, so a union would quietly never report
// what it is refusing. Derived from the inventory instead, so a column
// classified next month is in `all` without anybody remembering to add it — and
// an unresolved one appears here in order to be refused out loud.
FAMILIES.all = [
  ...moneyColumns.columnsOfUnit('amount'),
  ...moneyColumns.columnsOfUnit('rate'),
  ...moneyColumns.columnsOfUnit('unresolved'),
].map((c) => c.key);

// ── Arguments ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  if (!argv[at + 1]) { console.error(`[migrate_money] ${name} needs an argument.`); process.exit(2); }
  return argv[at + 1];
};
const dbPath = flag('--db');
if (!dbPath) {
  console.error('[migrate_money] --db <path> is required. This never defaults to production.');
  console.error('  Rehearse first: gunzip a snapshot from /root/backups/hourly and point --db at it.');
  process.exit(2);
}
const familyName = flag('--family') || 'refunds';
if (!FAMILIES[familyName]) {
  console.error(`[migrate_money] unknown family "${familyName}". One of: ${Object.keys(FAMILIES).join(', ')}`);
  process.exit(2);
}
const APPLY = argv.includes('--apply');
const VERIFY = argv.includes('--verify');
const ROLLBACK = argv.includes('--rollback');
if ([APPLY, VERIFY, ROLLBACK].filter(Boolean).length > 1) {
  console.error('[migrate_money] pick one of --apply, --verify, --rollback.');
  process.exit(2);
}

function open(file, readonly) {
  if (!fs.existsSync(file)) { console.error(`[migrate_money] no database at ${file}`); process.exit(2); }
  try {
    const Better = require('better-sqlite3');
    const db = new Better(file, { readonly });
    db.prepare('SELECT 1').get();
    return db;
  } catch (e) {
    console.error('[migrate_money] could not open the database with better-sqlite3.');
    console.error('  ' + String(e.message).split('\n')[0]);
    process.exit(2);
  }
}

// The new column's name and scale, derived from the inventory rather than from
// the caller. `_cents` for an amount and `_micro` for a rate: JavaScript has no
// unit type and this codebase has no type checker, so THE SUFFIX IS THE TYPE
// SYSTEM. A column that changes unit while keeping its name is a trap set for
// whoever reads the code next.
function target(key) {
  const [table, column] = key.split('.');
  const c = moneyColumns.classify(table, column);
  if (!c) return { key, skip: 'not in the inventory — classify it before migrating it' };
  if (c.unit === 'unresolved') return { key, skip: 'UNRESOLVED: ' + c.note };
  /* A QUOTIENT COLUMN. Its unit is settled — it is an amount — but the value
     stored in it was divided out of another column, and rounding a quotient
     independently makes it disagree with its own source. retail_order_items
     .unit_price is the worked case: an Eleme line of 10.00 over 3 units stores
     3.3333…, which multiplies back to 1000 cents today and to 999 once rounded
     to 333. Invariant B — the check that exists to catch a rate converted as an
     amount — would be reporting the migration's own arithmetic.
     Refused OUT LOUD rather than converted on the generic path, the same way an
     unresolved column is, until the derivation is implemented. */
  if (c.deriveFrom) {
    return { key, skip: `DERIVED FROM ${table}.${c.deriveFrom}: rounding this column independently breaks its own line. ${c.note}` };
  }
  if (c.unit === 'not_money') return { key, skip: 'not money: ' + c.note };
  if (c.done) return { key, skip: 'already an integer column' };
  return {
    key, table, column, unit: c.unit, kind: c.kind,
    to: column + (c.unit === 'rate' ? '_micro' : '_cents'),
    scale: c.unit === 'rate' ? 10000 : 100,
  };
}

const columns = FAMILIES[familyName].map(target);
const doable = columns.filter((c) => !c.skip);
const skipped = columns.filter((c) => c.skip);

const has = (db, table, column) => {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column); }
  catch (e) { return false; }
};
const tableExists = (db, table) => {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table); }
  catch (e) { return false; }
};

console.log('');
console.log('═'.repeat(72));
console.log(`MONEY LADDER · rung 1 (add + backfill) · family "${familyName}" · ${dbPath}`);
console.log('═'.repeat(72));

// ── Report ────────────────────────────────────────────────────────────────
if (!APPLY && !VERIFY && !ROLLBACK) {
  const db = open(dbPath, true);
  console.log('\n  Would add:');
  for (const c of doable) {
    if (!tableExists(db, c.table)) { console.log(`    · ${c.key} — no such table here, would skip`); continue; }
    /* AND THE COLUMN, not only its table. The apply path below has always
       checked both; this one checked only the table, so a database whose
       retail_orders predates a column the inventory knows about — an older
       tenant file, or any fixture — crashed the DRY RUN with a bare
       SqliteError. The report is the step somebody runs first, on the database
       they are least sure about, which is exactly the wrong place to throw. */
    if (!has(db, c.table, c.column)) { console.log(`    · ${c.key} — no such column here, would skip`); continue; }
    const already = has(db, c.table, c.to);
    const n = db.prepare(`SELECT COUNT(${c.column}) AS n FROM ${c.table}`).get().n;
    console.log(`    ${already ? '·' : '+'} ${c.table}.${c.to.padEnd(30)} ${String(n).padStart(7)} value(s)`
      + `  ${c.unit === 'rate' ? '×10,000 (rate)' : '×100 (cents)'}${already ? '   [already there]' : ''}`);
  }
  if (skipped.length) {
    console.log('\n  Would NOT touch:');
    for (const c of skipped) console.log(`    ✗ ${c.key}\n        ${c.skip}`);
  }
  console.log('\n  Nothing has changed. Add --apply to do it.');
  console.log('  Record the baseline FIRST:');
  console.log(`    node scripts/check_money_invariants.js --db ${dbPath} --json > before.json`);
  console.log('');
  db.close();
  process.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────────
if (APPLY) {
  const db = open(dbPath, false);
  let added = 0, filled = 0;
  // ONE TRANSACTION for the whole family. A half-applied family is the state
  // nobody can reason about: some columns present and filled, some absent, and
  // a verify that cannot say which run left it that way.
  const tx = db.transaction(() => {
    for (const c of doable) {
      if (!tableExists(db, c.table)) { console.log(`  · ${c.key} — no such table here, skipped`); continue; }
      if (!has(db, c.table, c.column)) { console.log(`  · ${c.key} — no such column here, skipped`); continue; }
      if (!has(db, c.table, c.to)) {
        db.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.to} INTEGER`);
        added++;
      }
      // CAST(ROUND(x)) rather than CAST(x): SQLite's CAST to INTEGER TRUNCATES,
      // so 1.999999 would become 1 rather than 2 — which is exactly the float
      // dust this migration exists to remove, silently rounded the wrong way.
      // NULL stays NULL: an absent amount is not zero.
      const r = db.prepare(
        `UPDATE ${c.table} SET ${c.to} = CAST(ROUND(${c.column} * ${c.scale}) AS INTEGER)
          WHERE ${c.column} IS NOT NULL`
      ).run();
      filled += r.changes;
      console.log(`  + ${c.table}.${c.to}  ${r.changes} row(s) filled`);
    }
  });
  tx();
  db.close();
  console.log(`\n  ${added} column(s) added, ${filled} value(s) written. Nothing reads them yet.`);
  console.log('  Now prove it:');
  console.log(`    node scripts/migrate_money.js --db ${dbPath} --family ${familyName} --verify`);
  console.log(`    node scripts/check_money_invariants.js --db ${dbPath} --baseline before.json`);
  console.log('');
  process.exit(0);
}

// ── Verify ────────────────────────────────────────────────────────────────
// Three questions, and the third is the one that matters.
//
//   1  is every value present?      a NULL where the REAL is not null is a
//                                   row the backfill missed.
//   2  does every value agree?      col_cents = ROUND(col * scale), row by row.
//   3  does the TOTAL agree?        SUM(col_cents) against SUM(ROUND(col*scale)).
//
// Three exists because one and two can both pass on a table the migration never
// reached — if the column was added but the UPDATE matched nothing, every row
// is NULL on both sides and a naive comparison calls that agreement.
if (VERIFY) {
  const db = open(dbPath, true);
  let bad = 0, checked = 0;
  for (const c of doable) {
    if (!tableExists(db, c.table) || !has(db, c.table, c.column)) continue;
    if (!has(db, c.table, c.to)) { console.log(`  ✗ ${c.key} — ${c.to} is not there at all`); bad++; continue; }
    const r = db.prepare(
      `SELECT COUNT(${c.column}) AS src,
              COUNT(${c.to})     AS dst,
              SUM(CASE WHEN ${c.column} IS NOT NULL
                        AND ${c.to} IS NULL THEN 1 ELSE 0 END) AS missing,
              SUM(CASE WHEN ${c.column} IS NOT NULL AND ${c.to} IS NOT NULL
                        AND ${c.to} <> CAST(ROUND(${c.column} * ${c.scale}) AS INTEGER)
                       THEN 1 ELSE 0 END) AS disagree,
              COALESCE(SUM(${c.to}), 0) AS sum_dst,
              COALESCE(SUM(CAST(ROUND(${c.column} * ${c.scale}) AS INTEGER)), 0) AS sum_src
         FROM ${c.table}`
    ).get();
    checked++;
    const ok = r.src === r.dst && !r.missing && !r.disagree && r.sum_dst === r.sum_src;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${c.table}.${c.to}`
      + `  ${r.dst}/${r.src} filled, ${r.disagree || 0} disagree, total ${r.sum_dst} vs ${r.sum_src}`);
  }
  db.close();
  console.log('');
  if (bad) {
    console.log(`  ${bad} of ${checked} column(s) did NOT verify. Roll back and find out why:`);
    console.log(`    node scripts/migrate_money.js --db ${dbPath} --family ${familyName} --rollback`);
  } else {
    console.log(`  ${checked} column(s) verified: every value present, every value equal, every total equal.`);
    console.log('  The REAL columns are untouched, so the application still behaves identically.');
  }
  console.log('');
  process.exit(bad ? 1 : 0);
}

// ── Rollback ──────────────────────────────────────────────────────────────
// The whole reason rung 1 is worth shipping on its own: undoing it is dropping
// a column nothing reads. SQLite has supported DROP COLUMN since 3.35.
if (ROLLBACK) {
  const db = open(dbPath, false);
  let dropped = 0;
  const tx = db.transaction(() => {
    for (const c of doable) {
      if (!tableExists(db, c.table) || !has(db, c.table, c.to)) continue;
      db.exec(`ALTER TABLE ${c.table} DROP COLUMN ${c.to}`);
      dropped++;
      console.log(`  − ${c.table}.${c.to}`);
    }
  });
  try { tx(); } catch (e) {
    console.error(`\n  Could not drop: ${String(e.message).split('\n')[0]}`);
    console.error('  SQLite needs 3.35+ for DROP COLUMN. Restore the copy instead.');
    db.close();
    process.exit(1);
  }
  db.close();
  console.log(`\n  ${dropped} column(s) dropped. The database is back where it started.`);
  console.log('');
  process.exit(0);
}
