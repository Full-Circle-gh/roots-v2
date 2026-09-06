#!/usr/bin/env node
//
// test_money_migration.js — rung 1 of the money ladder, proven (audit A-06).
//
// scripts/migrate_money.js adds an integer column beside each REAL money column
// and fills it in. Nothing reads the new column yet, which is what makes this
// rung shippable on its own — and it is also what makes it easy to get wrong
// without anybody noticing, because nothing depends on the answer until rung 4.
//
// So the properties are checked here, against a real SQLite engine, by running
// the actual script rather than a copy of its SQL.
//
// THE FOUR THAT WOULD COST THE MOST
//
//   CAST TRUNCATES.  SQLite's CAST(1.999999 AS INTEGER) is 1, not 2. A backfill
//                    written CAST(x*100) instead of CAST(ROUND(x*100)) rounds
//                    every float-dusted value DOWN by a cent — silently, on
//                    exactly the rows this migration exists to clean up.
//   A RATE IS NOT AN AMOUNT.  0.042 yuan/g in cents is 4, which is 5% wrong
//                    for ever. It has to be 420 ten-thousandths.
//   NULL IS NOT ZERO.  An absent amount that becomes 0 is a number nobody
//                    entered, and it will sum.
//   RUNNING IT TWICE.  A migration that is not idempotent cannot be re-run
//                    after a partial failure, which is when it is most needed.
//
//   node scripts/test_money_migration.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

let Database;
try { Database = require('better-sqlite3'); }
catch (e) { console.log('  ! better-sqlite3 is not built here — skipping'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate_money.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'money-mig-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ } });

// Run the REAL script. A test that reimplements the migration proves nothing
// about the migration that ships.
function migrate(dbFile, args) {
  try {
    return { out: execFileSync('node', [SCRIPT, '--db', dbFile, ...args], { encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

// A fixture carrying the exact values production actually holds. These are not
// invented: 45.999999999999996 and 1.7342365999999998 were read off the live
// database by scripts/diagnose_money_precision.js.
function fixture(name) {
  const file = path.join(tmp, name + '.db');
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, order_no TEXT, customer_id INTEGER, status TEXT,
      subtotal REAL, shipping_fee REAL, packing_fee REAL, same_day_surcharge_fee REAL, voucher_amount REAL,
      points_amount REAL, balance_used REAL, total REAL, refund_amount_requested REAL,
      refund_amount_approved REAL, refund_amount_paid REAL, refund_cash_amount REAL,
      channel_commission REAL, channel_settle_amount REAL, channel_discount REAL);
    CREATE TABLE retail_payments (id INTEGER PRIMARY KEY, order_id INTEGER, method TEXT, status TEXT,
      amount REAL, refunded_amount REAL);
    CREATE TABLE retail_order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT, qty REAL,
      unit_price REAL, line_total REAL, unit_cost_at_sale REAL, refunded_qty INTEGER);
    CREATE TABLE ingredients (id INTEGER PRIMARY KEY, name_en TEXT, cost_per_unit REAL, buy_price REAL);
    CREATE TABLE retail_vouchers (id INTEGER PRIMARY KEY, code TEXT, type TEXT, value REAL, min_subtotal REAL);
  `);
  db.prepare('INSERT INTO retail_payments VALUES (1,1,?,?,?,?)').run('wechat', 'success', 45.99, 45.999999999999996);
  db.prepare('INSERT INTO retail_payments VALUES (2,2,?,?,?,?)').run('wechat', 'success', 10, null);
  db.prepare(`INSERT INTO retail_orders (id, order_no, status, refund_amount_paid, refund_cash_amount)
              VALUES (1,'A-1','refunded',45.999999999999996,45.99)`).run();
  db.prepare(`INSERT INTO retail_orders (id, order_no, status) VALUES (2,'A-2','completed')`).run();
  db.prepare('INSERT INTO ingredients VALUES (1,?,?,?)').run('Oat groats', 0.042, 42);
  db.prepare('INSERT INTO ingredients VALUES (2,?,?,?)').run('Cacao', 1.7342365999999998, 173.42);
  db.prepare('INSERT INTO retail_vouchers VALUES (1,?,?,?,?)').run('TEN', 'percent', 10, 0);
  db.close();
  return file;
}
const read = (file, sql) => { const db = new Database(file, { readonly: true }); const r = db.prepare(sql).all(); db.close(); return r; };
const cols = (file, table) => read(file, `PRAGMA table_info(${table})`).map((c) => c.name);

// ── §1 · nothing happens without being asked ──────────────────────────────
section('1 · a migration that runs somewhere nobody named is the one mistake it must not allow');
{
  let out;
  try { execFileSync('node', [SCRIPT], { encoding: 'utf8' }); out = ''; }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  yes(/--db <path> is required/.test(out), '--db is required — it never defaults to production');
  yes(/never defaults to production/.test(out), 'and says so');
}
{
  const f = fixture('dry');
  const r = migrate(f, []);
  yes(/Would add/.test(r.out), 'a bare run says what it would do');
  yes(/Nothing has changed/.test(r.out), 'and says that nothing changed');
  is(cols(f, 'retail_payments').includes('amount_cents'), false, 'and really changes nothing');
  yes(/Record the baseline FIRST/.test(r.out), 'and points at the baseline first');
}

// ── §2 · the backfill itself ──────────────────────────────────────────────
section('2 · what lands in the new column');
{
  const f = fixture('apply');
  migrate(f, ['--apply']);
  const p = read(f, 'SELECT * FROM retail_payments ORDER BY id');
  // THE ONE THAT WOULD COST THE MOST. CAST(45.999999999999996 * 100) truncates
  // to 4599 — a cent short, on precisely the rows this migration is for.
  is(p[0].refunded_amount_cents, 4600, 'float dust rounds to the cent it was meant to be, not down');
  is(p[0].amount_cents, 4599, 'and a clean value is unchanged');
  is(p[1].refunded_amount_cents, null, 'NULL stays NULL — an absent amount is not zero');
  const o = read(f, 'SELECT * FROM retail_orders ORDER BY id');
  is(o[0].refund_amount_paid_cents, 4600, 'the same on the order side');
  is(o[1].refund_amount_paid_cents, null, 'and an order that was never refunded gets nothing');
  is(read(f, 'SELECT amount FROM retail_payments WHERE id=1')[0].amount, 45.99,
    'the REAL column is untouched — the application behaves identically after this rung');
}

// ── §3 · a rate is not an amount ──────────────────────────────────────────
section('3 · the 5%-wrong-for-ever error');
{
  const f = fixture('rates');
  migrate(f, ['--family', 'purchasing', '--apply']);
  const i = read(f, 'SELECT * FROM ingredients ORDER BY id');
  yes(cols(f, 'ingredients').includes('cost_per_unit_micro'),
    'a rate gets a _micro column, not a _cents one — the suffix is the type system');
  is(i[0].cost_per_unit_micro, 420, '0.042 yuan per gram is 420 ten-thousandths');
  yes(!cols(f, 'ingredients').includes('cost_per_unit_cents'),
    'and never a cents column, where it would have been 4 — a 5% error in every recipe');
  is(i[0].buy_price_cents, 4200, 'while buy_price beside it IS an amount, and goes to cents');
  is(i[1].cost_per_unit_micro, 17342, '1.7342365999999998 keeps four places and loses the dust');
}

// ── §4 · what it refuses ──────────────────────────────────────────────────
section('4 · the column it will not touch');
{
  const f = fixture('refuse');
  const r = migrate(f, ['--family', 'all', '--apply']);
  is(cols(f, 'retail_vouchers').includes('value_cents'), false,
    'retail_vouchers.value is NOT converted — it holds a percentage for percent coupons');
  is(read(f, 'SELECT value FROM retail_vouchers')[0].value, 10,
    'and "10% off" is still 10, not 1000');
  const dry = migrate(fixture('refuse2'), ['--family', 'all']);
  yes(/UNRESOLVED/.test(dry.out), 'the plan says out loud which columns it is refusing');
  yes(/percent/i.test(dry.out), 'and why');
}

// ── §5 · running it twice ─────────────────────────────────────────────────
section('5 · idempotent, because a migration is most needed after a partial failure');
{
  const f = fixture('twice');
  migrate(f, ['--apply']);
  const first = read(f, 'SELECT id, amount_cents, refunded_amount_cents FROM retail_payments ORDER BY id');
  const r = migrate(f, ['--apply']);
  is(r.code, 0, 'a second run succeeds');
  const second = read(f, 'SELECT id, amount_cents, refunded_amount_cents FROM retail_payments ORDER BY id');
  is(JSON.stringify(second), JSON.stringify(first), 'and changes nothing');
  is(cols(f, 'retail_payments').filter((c) => c === 'amount_cents').length, 1,
    'the column is added once, not twice');
}
{
  // The case idempotency is FOR: a value edited between two runs is picked up,
  // rather than the second run assuming the first one finished the job.
  const f = fixture('resync');
  migrate(f, ['--apply']);
  const db = new Database(f);
  db.prepare('UPDATE retail_payments SET amount = 99.99 WHERE id = 1').run();
  db.close();
  migrate(f, ['--apply']);
  is(read(f, 'SELECT amount_cents FROM retail_payments WHERE id=1')[0].amount_cents, 9999,
    'a value that changed between runs is re-derived, not left stale');
}

// ── §6 · verify, and what it catches ──────────────────────────────────────
section('6 · the proof, and its ability to go red');
{
  const f = fixture('verify');
  migrate(f, ['--apply']);
  const good = migrate(f, ['--verify']);
  is(good.code, 0, 'a faithful backfill verifies');
  yes(/every value present, every value equal, every total equal/.test(good.out), 'and says on what grounds');

  const db = new Database(f);
  db.prepare('UPDATE retail_payments SET amount_cents = 4598 WHERE id = 1').run();
  db.close();
  const bad2 = migrate(f, ['--verify']);
  is(bad2.code, 1, 'one cent wrong on one row fails the verify');
  yes(/disagree/.test(bad2.out), 'and names what disagreed');
}
{
  const f = fixture('missing');
  migrate(f, ['--apply']);
  const db = new Database(f);
  db.prepare('UPDATE retail_payments SET amount_cents = NULL WHERE id = 1').run();
  db.close();
  is(migrate(f, ['--verify']).code, 1, 'a row the backfill missed fails it too');
}

// ── §7 · undoing it ───────────────────────────────────────────────────────
section('7 · rung 1 is reversible, which is the whole reason it ships alone');
{
  const f = fixture('rollback');
  const before = cols(f, 'retail_payments').join(',');
  migrate(f, ['--apply']);
  yes(cols(f, 'retail_payments').includes('amount_cents'), 'applied');
  const r = migrate(f, ['--rollback']);
  is(r.code, 0, 'rolling back succeeds');
  is(cols(f, 'retail_payments').join(','), before, 'and the table is exactly as it was');
  is(read(f, 'SELECT amount, refunded_amount FROM retail_payments WHERE id=1')[0].amount, 45.99,
    'with every original value still in place');
}

// ─────────────────────────────────────────────────────────────────────────
section('8 · a quotient column is refused, not converted on the generic path');

/* retail_order_items.unit_price is an AMOUNT — its unit is settled — but the
   value in it was DIVIDED out of line_total: routes/eleme-internal.js:316
   computes `line / qty` when the channel sends a total and no unit price. An
   Eleme line of 10.00 over 3 units stores 3.3333…, which multiplies back to
   1000 cents today and to 999 once rounded to 333.

   Invariant B is `ROUND(unit_price × qty) = ROUND(line_total)` — the check that
   exists to catch a rate converted as an amount. Converting this column on the
   generic ROUND(col × 100) path would make that check report the migration's
   own arithmetic, on 5.4% of lines, at a cent each.

   So the registry carries `deriveFrom` and migrate_money.js refuses the column.
   The marker is a FIELD rather than a sentence in the note because a note does
   not execute, and this assertion is what stops it being dropped as redundant. */
{
  const moneyColumns = require(path.join(ROOT, 'lib', 'money-columns'));
  const c = moneyColumns.classify('retail_order_items', 'unit_price');
  is(c.unit, 'amount', 'its unit is settled — it is an amount, not unresolved');
  is(c.deriveFrom, 'line_total', '…and it is marked as derived FROM line_total');

  // The arithmetic, run rather than recalled.
  const line = 10.00, qty = 3, unit = line / qty;
  is(Math.round(unit * qty * 100), Math.round(line * 100),
    'the stored REAL multiplies back to its line total today');
  const naive = Math.round(unit * 100);
  yes(naive * qty !== Math.round(line * 100),
    `…and rounding it independently would not: ${naive} x ${qty} = ${naive * qty} against ${Math.round(line * 100)}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
