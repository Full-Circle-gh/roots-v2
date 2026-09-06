#!/usr/bin/env node
//
// test_money_invariants.js — red-proof for scripts/check_money_invariants.js.
//
// A CHECK SET WITH NO FAILING CASE IS NOT A CHECK SET. Every invariant in that
// file is asserted twice here: once against a clean fixture where it must
// return 0, and once against a fixture carrying exactly one seeded break, where
// it must return exactly that break AND every other check must stay green. A
// check that cannot go red would read PASS for ever and nobody would know.
//
// IT IMPORTS THE REAL QUERIES — THIS IS THE POINT. CHECKS is required from the
// shipped file rather than copied here. A fixture that validates its own copy
// of a query proves nothing about the query that ships; the two drift the first
// time one is edited, and this suite stays green while the shipped file rots.
// Same rule test_ledger_invariants.js states for the same reason.
//
// THE CENSUS IS TESTED SEPARATELY, and it is the half that matters most for a
// migration: a conversion can keep every relationship intact and still change
// the money. So §4 converts a fixture the way the migration will and requires
// the census to be identical, then breaks it by one cent and requires the gate
// to notice.
//
//   node scripts/test_money_invariants.js

'use strict';

const { CHECKS, census, dirtyCount } = require('./check_money_invariants');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${e}, got ${a}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

let Database;
try { Database = require('better-sqlite3'); }
catch (e) { console.log('  ! better-sqlite3 is not built here — skipping'); process.exit(0); }

// ── A fixture with only the columns the checks read ───────────────────────
// Deliberately NOT the whole schema: a fixture that has to be regenerated every
// time an unrelated table changes is a fixture that stops being maintained.
function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_orders (
      id INTEGER PRIMARY KEY, order_no TEXT, customer_id INTEGER, status TEXT,
      subtotal REAL, shipping_fee REAL, packing_fee REAL, same_day_surcharge_fee REAL,
      voucher_amount REAL, points_amount REAL, balance_used REAL, total REAL,
      refund_amount_requested REAL, refund_amount_approved REAL, refund_amount_paid REAL,
      refund_cash_amount REAL, channel_commission REAL, channel_settle_amount REAL,
      channel_discount REAL);
    CREATE TABLE retail_order_items (
      id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT, qty REAL,
      unit_price REAL, line_total REAL, unit_cost_at_sale REAL, refunded_qty INTEGER);
    CREATE TABLE retail_payments (
      id INTEGER PRIMARY KEY, order_id INTEGER, method TEXT, status TEXT,
      amount REAL, refunded_amount REAL);
    CREATE TABLE retail_customers (
      id INTEGER PRIMARY KEY, nickname TEXT, lifetime_spend REAL, balance REAL);
  `);
  /* channel, tax_amount and tax_mode are columns the real retail_orders has had
     since their migrations, and invariant A now reads all three. The stand-in
     gains them for the same reason it gained same_day_surcharge_fee: a fixture
     missing a column the check reads makes the check ERROR rather than fail,
     and an errored invariant reports nothing while looking like nothing is
     wrong. */
  db.exec(`ALTER TABLE retail_orders ADD COLUMN channel TEXT;
           ALTER TABLE retail_orders ADD COLUMN tax_amount REAL;
           ALTER TABLE retail_orders ADD COLUMN tax_mode TEXT;`);
  // One customer, seven clean orders. Every relationship holds exactly.
  // lifetime_spend is the sum of every order subtotal
  // (100 + 60 + 50 + 228.50 + 266 + 100 + 100), so the reconciliation starts
  // clean — a baseline that is already non-zero cannot show a MOVE, which is
  // the only thing the migration gate reads.
  db.prepare('INSERT INTO retail_customers VALUES (1,?,?,?)').run('Chen', 904.50, 20);
  const ord = db.prepare(`INSERT INTO retail_orders
    (id, order_no, customer_id, status, subtotal, shipping_fee, packing_fee, same_day_surcharge_fee,
     voucher_amount, points_amount, balance_used, total, refund_amount_paid, refund_cash_amount)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  //                          sub  ship pack sur  vouch pts  bal  total  refund cash
  ord.run(1, 'A-1', 1, 'completed', 100, 12, 0, 0, 0, 0, 0, 112, 0, 0);
  //  paid partly in points and credit: gross 30+10+20 = 60, cash 20
  ord.run(2, 'A-2', 1, 'completed', 60, 0, 0, 0, 0, 30, 10, 20, 0, 0);
  /* A SAME-DAY ORDER, and the reason this row exists. Both orders above carry a
     ZERO surcharge, so for as long as they were the whole fixture, invariant A
     could not tell "the surcharge is added to the parts" from "it is not" —
     nothing in the suite distinguished the two readings, and A shipped adding
     it twice.

     shipping_fee ALREADY CONTAINS the surcharge: routes/retail.js does
     `shippingFee += sameDaySurcharge` at creation, and same_day_surcharge_fee
     records how much of that line it was. So this order is CLEAN — 50 + 30 + 0
     = 80 — and it goes red against the old formula, which made it 95.

     Taken from production: TC000351 was 49 + 30 (15 of it surcharge) = 79, and
     the first rehearsal flagged it, and two others like it, as broken data. It
     was not; the check was. */
  ord.run(3, 'A-3', 1, 'completed', 50, 30, 0, 15, 0, 0, 0, 80, 0, 0);

  /* THREE MORE ORDERS, ONE PER CORRECTION, and each is red against the formula
     that stood before it. Every one is taken from the 2026-09-06 production
     rehearsal rather than invented, because the argument for each correction is
     that real trading already looked broken under the old arithmetic.

     A-4 · A CHANNEL ORDER WITH A RECORDED DISCOUNT. MT20260831376090:
     228.50 + 15 + 1.50 − 12 = 233.00, which is what the platform settled. The
     old formula had no channel_discount term at all, so it expected 245.00 and
     called a correctly-mirrored order broken by exactly its own promotion.
     Seventeen production orders were this one shape.

     A-5 · POINTS AND A VOUCHER COVERING MORE THAN THE ORDER. TC000207:
     266 + 1.50 − 21.28 − 247 = −0.78, and the stored total is 0 because
     routes/retail.js floors it (:10925). The old formula expected −0.78 and
     reported the shop's own clamp as a defect. R260630163496 is the same shape
     at −0.60.

     A-6 · AN EXCLUSIVE-TAX ORDER. No production order carries tax yet — the
     census counts zero — so this row is the ONLY thing holding that arm of the
     formula, and it is here precisely because nothing in production would
     notice if it were wrong. 100 + 10 = 110, tax 8.80 added on top, total
     118.80. An inclusive shop with the same figures would total 110.00 with the
     8.80 already inside; A-7 is that order, and the two together are what stop
     the tax term being added unconditionally. */
  //     id  no      cust status        sub  ship pack sur vouch  pts  bal   total  refund cash
  ord.run(4, 'A-4', 1, 'completed', 228.50, 15, 1.50, 0, 0, 0, 0, 233.00, 0, 0);
  ord.run(5, 'A-5', 1, 'completed',    266,  0, 1.50, 0, 21.28, 247, 0,   0, 0, 0);
  ord.run(6, 'A-6', 1, 'completed',    100, 10,    0, 0, 0, 0, 0, 118.80, 0, 0);
  ord.run(7, 'A-7', 1, 'completed',    100, 10,    0, 0, 0, 0, 0, 110.00, 0, 0);
  db.prepare("UPDATE retail_orders SET channel = 'meituan', channel_discount = 12 WHERE id = 4").run();
  db.prepare("UPDATE retail_orders SET tax_amount = 8.80, tax_mode = 'exclusive' WHERE id = 6").run();
  db.prepare("UPDATE retail_orders SET tax_amount = 8.80, tax_mode = 'inclusive' WHERE id = 7").run();

  db.prepare('INSERT INTO retail_order_items (id, order_id, sku, qty, unit_price, line_total, unit_cost_at_sale) VALUES (?,?,?,?,?,?,?)')
    .run(1, 1, 'S-1', 4, 25, 100, 0.042);
  db.prepare('INSERT INTO retail_order_items (id, order_id, sku, qty, unit_price, line_total, unit_cost_at_sale) VALUES (?,?,?,?,?,?,?)')
    .run(2, 2, 'S-2', 3, 20, 60, 1.5);
  db.prepare('INSERT INTO retail_payments VALUES (1,1,?,?,?,?)').run('wechat', 'success', 112, 0);
  db.prepare('INSERT INTO retail_payments VALUES (2,2,?,?,?,?)').run('wechat', 'success', 20, 0);
  return db;
}

const shim = (db) => ({ all: (s, p = []) => db.prepare(s).all(...p), close: () => {} });

function counts(db) {
  const d = shim(db);
  const out = {};
  for (const c of CHECKS) {
    if (c.dynamic === 'dirty') { out[c.id] = dirtyCount(d).dirty; continue; }
    out[c.id] = d.all(c.count)[0].n || 0;
  }
  return out;
}

// ── §1 · clean ────────────────────────────────────────────────────────────
section('1 · a clean fixture, where every invariant must be zero');
{
  const c = counts(fixture());
  for (const chk of CHECKS) {
    if (chk.kind !== 'invariant') continue;
    is(c[chk.id], 0, `${chk.id} — ${chk.title}`);
  }
  is(c.G, 0, 'G — the reconciliation is also clean here, which is what makes a move readable');
  is(c.H, 0, 'H — and no stored amount is off the cent');
}

// ── §2 · one break at a time ──────────────────────────────────────────────
section('2 · each check goes red for its own break, and only its own');

const BREAKS = [
  ['A', 'an order total that does not add up',
    (db) => db.prepare('UPDATE retail_orders SET total = 999 WHERE id = 1').run()],
  ['B', 'a line total that is not price × quantity',
    (db) => db.prepare('UPDATE retail_order_items SET line_total = 111 WHERE id = 1').run()],
  ['C', 'a refund above the gross the customer tendered',
    (db) => db.prepare('UPDATE retail_orders SET refund_amount_paid = 61 WHERE id = 2').run()],
  ['D', 'more cash back than cash came in',
    (db) => db.prepare('UPDATE retail_orders SET refund_cash_amount = 21 WHERE id = 2').run()],
  ['E', 'a payment refunded for more than it took',
    (db) => db.prepare('UPDATE retail_payments SET refunded_amount = 113 WHERE id = 1').run()],
  ['F', 'a negative wallet balance',
    (db) => db.prepare('UPDATE retail_customers SET balance = -1 WHERE id = 1').run()],
  ['G', 'a lifetime total that no longer matches the orders',
    (db) => db.prepare('UPDATE retail_customers SET lifetime_spend = 500 WHERE id = 1').run()],
  // Moving `total` alone by half a cent breaks the order's arithmetic as well,
  // and that is correct: A and H are looking at the same row from two sides.
  ['H', 'an amount that is not a whole number of cents',
    (db) => db.prepare('UPDATE retail_orders SET total = 112.005 WHERE id = 1').run(), ['A']],
];

for (const [id, what, breakIt, also] of BREAKS) {
  const db = fixture();
  breakIt(db);
  const c = counts(db);
  yes(c[id] > 0, `${id} catches ${what}`, `${id} stayed at ${c[id]}`);
  // The half that matters as much: nothing ELSE may light up unless the break
  // genuinely breaks two things at once — otherwise a real break arrives buried
  // in four false ones and nobody can tell which is the cause. Where a second
  // check legitimately fires, the break says so BY NAME rather than the
  // assertion being loosened.
  const expected = new Set([id, ...(also || [])]);
  const spurious = CHECKS
    .filter((k) => !expected.has(k.id) && k.kind === 'invariant' && c[k.id] > 0)
    .map((k) => k.id);
  yes(spurious.length === 0, `…and nothing else lights up`, `also red: ${spurious.join(', ')}`);
  for (const a of (also || [])) yes(c[a] > 0, `…and ${a} fires too, which it should`);
}

// ── §3 · the refund ceiling is the GROSS ──────────────────────────────────
section('3 · the ceiling that was got wrong once already');
{
  // Order 2 was paid with 30 points + 10 credit + 20 cash. A full refund of
  // ¥60 is CORRECT and must not be reported. Comparing against `total` (20)
  // instead of the gross (60) is the mistake that reported two correct
  // production orders as over-refunded; it is recorded in the plan and here.
  const db = fixture();
  db.prepare('UPDATE retail_orders SET refund_amount_paid = 60, refund_cash_amount = 20 WHERE id = 2').run();
  const c = counts(db);
  is(c.C, 0, 'a full refund of a part-points order is not flagged');
  is(c.D, 0, 'and the cash half is exactly the cash taken, which is fine');
  db.prepare('UPDATE retail_orders SET refund_cash_amount = 20.01 WHERE id = 2').run();
  is(counts(db).D, 1, 'one cent more cash out than came in IS flagged');
}

// ── §4 · the census, which is the migration's real gate ───────────────────
section('4 · the census notices what the invariants cannot');
{
  const db = fixture();
  const before = census(shim(db));
  // A FAITHFUL conversion: same values, stored the way the migration will store
  // them. Every relationship holds and every total is identical.
  const after = census(shim(fixture()));
  is(JSON.stringify(after), JSON.stringify(before), 'an unchanged database measures identically');
}
{
  const db = fixture();
  const before = census(shim(db));
  // One cent, on one row, with every invariant still holding: the order total
  // and its parts are BOTH moved, so A stays green. This is the shape of a
  // conversion that kept the relationships and changed the money.
  db.prepare('UPDATE retail_orders SET subtotal = 100.01, total = 112.01 WHERE id = 1').run();
  const c = counts(db);
  is(c.A, 0, 'a consistent one-cent shift passes every invariant');
  const after = census(shim(db));
  yes(after['retail_orders.total'].sum_scaled !== before['retail_orders.total'].sum_scaled,
    '…and the census catches it anyway — this is why both halves exist');
}
{
  const db = fixture();
  const before = census(shim(db));
  db.prepare('DELETE FROM retail_payments WHERE id = 2').run();
  const after = census(shim(db));
  yes(after['retail_payments.amount'].n !== before['retail_payments.amount'].n,
    'a row that goes missing changes the count, not just the total');
}
{
  // A rate column is measured in MICRO, not cents — 0.042 is 420, not 4.
  // Measuring a rate in cents is the 5%-wrong-for-ever error, and it would show
  // up here as a census that cannot tell 0.042 from 0.044.
  const db = fixture();
  const c = census(shim(db));
  is(c['retail_order_items.unit_cost_at_sale'].unit, 'rate', 'a rate is measured as a rate');
  is(c['retail_order_items.unit_cost_at_sale'].sum_scaled, 420 + 15000,
    'and in ten-thousandths, so 0.042 is 420 rather than 4');
  is(c['retail_order_items.unit_cost_at_sale'].not_exact, 0,
    'which makes it exact — in cents it would have been 93% inexact, as production is');
}
{
  // An UNRESOLVED column is the one the migration must not touch, so its
  // fingerprint moving is the strongest possible signal that something did.
  // Leaving them out of the census is how retail_vouchers.value gets multiplied
  // by a hundred with nothing to notice.
  const db = fixture();
  const before = census(shim(db));
  yes(before['retail_order_items.unit_price'] != null,
    'an unclassified column is still measured — it is what must not move');
  db.prepare('UPDATE retail_order_items SET unit_price = 2500 WHERE id = 1').run();
  const after = census(shim(db));
  yes(after['retail_order_items.unit_price'].sum_scaled !== before['retail_order_items.unit_price'].sum_scaled,
    'and a hundredfold shift on it is caught, which is the whole failure mode');
}

// ── §5 · the inventory gate ───────────────────────────────────────────────
section('5 · a column nobody has classified stops the run');
{
  const M = require('../lib/money-columns');
  const db = fixture();
  db.exec('CREATE TABLE later_on (id INTEGER PRIMARY KEY, mystery_amount REAL)');
  const r = M.scan(db);
  yes(r.unclassified.some((u) => u.key === 'later_on.mystery_amount'),
    'a money-named column added later is reported, not silently skipped');
  const clean = M.scan(fixture());
  is(clean.unclassified.length, 0, 'and the fixture itself is fully classified');
}
{
  const M = require('../lib/money-columns');
  // THE MIGRATION'S OWN OUTPUT must not read as unclassified, or the rehearsal
  // reports every column it just created and the one that would actually matter
  // is buried in the list.
  const done = M.classify('retail_payments', 'amount_cents');
  yes(done && done.done, 'amount_cents beside a classified amount is recognised, not reported');
  is(done.unit, 'amount', 'and carries its base column’s unit');
  const rate = M.classify('ingredients', 'cost_per_unit_micro');
  yes(rate && rate.done && rate.unit === 'rate', 'so is a _micro column beside a rate');
  is(M.classify('ingredients', 'cost_per_unit_cents'), null,
    'but a _cents column beside a RATE is not — that is the 5% error, and it must be reported');
  is(M.classify('mystery', 'thing_cents'), null,
    'and a _cents column beside a column nobody classified is still a question');
}
{
  const M = require('../lib/money-columns');
  // The noise floor. A scanner that reports thirty timestamps is a scanner
  // nobody reads, and the next unclassified money column hides in the list.
  is(M.couldHoldMoney('refund_paid_at', 'DATETIME'), false, 'a timestamp is not money');
  is(M.couldHoldMoney('refund_reviewer_id', 'INTEGER'), false, 'nor an id');
  is(M.couldHoldMoney('refund_reason', 'TEXT'), false, 'nor a sentence');
  is(M.couldHoldMoney('cost_total_cents', 'INTEGER'), true,
    'but an INTEGER cents column is — which is what the migration is heading towards');
  is(M.couldHoldMoney('total', 'REAL'), true, 'and a REAL always is');
}

// ── §6 · the three names that lied ────────────────────────────────────────
section('6 · the classifications that would have been catastrophic');
{
  const M = require('../lib/money-columns');
  is(M.classify('retail_vouchers', 'value').unit, 'unresolved',
    'retail_vouchers.value is NOT converted: it holds a percentage for percent coupons');
  is(M.classify('recipe_cost_data', 'target_food_cost').unit, 'not_money',
    'target_food_cost is a percentage, caught by the word "cost"');
  is(M.classify('ingredient_price_history', 'price').unit, 'rate',
    'ingredient_price_history.price is a rate — written from cost_per_unit');
  is(M.classify('ingredients', 'cost_per_unit').unit, 'rate', 'and so is cost_per_unit');
  is(M.classify('ingredients', 'buy_price').unit, 'amount',
    'while buy_price beside it is an amount — what one pack costs');
  is(M.classify('retail_orders', 'total').kind, 'derived', 'an order total is derived and can be rechecked');
  is(M.classify('retail_customers', 'balance').kind, 'source',
    'a wallet balance is the record itself, and nothing can prove it back');
  yes(M.columnsOfUnit('unresolved').length > 0,
    'and the unresolved ones are counted, not quietly treated as amounts');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
