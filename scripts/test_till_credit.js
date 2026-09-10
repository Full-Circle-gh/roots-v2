#!/usr/bin/env node
/**
 * A walk-in can spend the points and the wallet balance they already have.
 *
 *   node scripts/test_till_credit.js
 *
 * No network, no keys, no server. `routes/retail.js` cannot be required (it
 * opens a real database at load), so the REAL functions are sliced out of the
 * file and executed against an in-memory database carrying the REAL table
 * definitions out of database.js — the technique test_manual_order_fees.js and
 * test_migration_credit_ledger.js use. Nothing here is a reimplementation: a
 * harness that rebuilt the redemption rule would be testing a different
 * program, and "the counter priced it differently from the app" is the exact
 * defect this suite exists to prevent.
 *
 * ── WHAT WAS WRONG (§93) ──────────────────────────────────────────────────
 * `POST /api/retail-admin/orders` — the path the counter till and the back
 * office both write through — accepted `payment_method: 'points'` and
 * `'balance'` in its ALLOWED_PAY list and TOUCHED NEITHER LEDGER. So an order
 * could be filed as paid in points while the customer's points balance sat
 * untouched, and `markOrderPaid` would then AWARD earn-points on top of it. The
 * values were unreachable from any screen, which is the only reason it had
 * never happened: the hole was latent, not live.
 *
 * ── WHAT THIS LOCKS DOWN ──────────────────────────────────────────────────
 *   • one rule, two surfaces: points and balance come off a hand-keyed order by
 *     the same helpers the customer checkout redeems through, in the same order
 *     (points first — they expire, a wallet does not);
 *   • a request for more points than the customer HAS is refused, never
 *     silently clamped down to the balance and charged the difference;
 *   • a request for more points than the ORDER can absorb IS clamped, because
 *     the extra would simply be burned;
 *   • a grand-total override caps the credit: an order overridden down to ¥5
 *     must not redeem against the ¥50 of goods behind it;
 *   • balance never pays shipping, with no setting that lets it, while points
 *     pay it only where `points.coverShipping` says so;
 *   • credit needs an account: a guest walk-in is refused, not quietly charged
 *     in full as though the credit had been spent;
 *   • the route asks for the credit before it opens its transaction and SPENDS
 *     it inside, against the same conditional UPDATEs the checkout uses, so two
 *     tills cannot both spend one balance.
 *
 * TO PROVE THE SUITE CAN FAIL:  TC_MUTANT=1 node scripts/test_till_credit.js
 * The mutant restores the pre-fix behaviour — manualOrderCredit answering "no
 * credit" for everything, which is what the route did before it called this at
 * all — and the suite must go RED. Per decisions §24 the mutation ASSERTS IT
 * MODIFIED THE SOURCE before its red counts as evidence.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { openTablesDb } = require('./test-support/memory-db');

const MUTANT = process.env.TC_MUTANT === '1';
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const DB_SRC = read('database.js');
const RETAIL_SRC = read('routes/retail.js');
const TILL_SRC = read('public/till.html');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── The real functions, lifted ────────────────────────────────────────────
// Whole-function slices by brace depth from the declaration. The parameter list
// is walked to its closing paren FIRST, because a destructured parameter opens
// a brace before the body does — `function manualOrderCredit({ customerId, … })`
// — and taking the first `{` after the name would grab the destructuring and
// hand back a signature with no body. The same trap test_manual_order_fees.js
// and test_point_search.js both record.
function grab(name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(RETAIL_SRC);
  assert.ok(m, `function ${name} not found in routes/retail.js`);
  let i = RETAIL_SRC.indexOf('(', m.index), depth = 0;
  for (; i < RETAIL_SRC.length; i++) {
    if (RETAIL_SRC[i] === '(') depth++;
    else if (RETAIL_SRC[i] === ')') { depth--; if (depth === 0) break; }
  }
  assert.strictEqual(depth, 0, `unterminated parameter list for ${name}`);
  i = RETAIL_SRC.indexOf('{', i);
  depth = 0;
  for (; i < RETAIL_SRC.length; i++) {
    const c = RETAIL_SRC[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  assert.strictEqual(depth, 0, `unterminated ${name}`);
  return RETAIL_SRC.slice(m.index, i + 1);
}

const LIFTED = [
  'cfgValue',
  'pointsRedeemRate', 'pointsCashValue', 'pointsRequiredFor', 'pointsCoverShipping',
  'pointsRedeemableBase', 'walletSpendableBase', 'walletSpendForOrder',
  'sweepExpiredPoints',
  'manualOrderCredit',
];
/* THE MUTATION IS A FUNCTION, NOT A ONE-OFF, because this file lifts
   manualOrderCredit TWICE — once on its own for the unit section, and once more
   inside the real handler for the end-to-end section below. Mutating only the
   first left eleven assertions passing under `TC_MUTANT=1` against a helper
   that returned nothing, which is precisely the "green over nothing" this
   repository keeps finding. Both lifts go through here, so a red run proves the
   whole file. */
function mutate(source) {
  if (!MUTANT) return source;
  const real = grab('manualOrderCredit');
  assert.ok(source.includes(real), 'mutation anchor not found — a red run would prove nothing');
  const mutated = source.replace(real,
    'function manualOrderCredit() { return { pointsUsed: 0, pointsAmount: 0, balanceUsed: 0, error: null }; }');
  assert.notStrictEqual(mutated, source, 'the mutant source is identical to the real source');
  /* Anchored on `credit_requires_customer`, which is manualOrderCredit's alone.
     The first anchor tried here was the points READ — and sweepExpiredPoints,
     also lifted, makes the same read, so the guard matched a function the
     mutation had not touched and refused a mutation that HAD taken. A guard
     that fires on the wrong function is worse than none: it reports the
     mutation as failed and the red as unproven. */
  assert.ok(!mutated.includes('credit_requires_customer'),
            'the mutant still carries manualOrderCredit\'s own refusal — the replacement did not take');
  return mutated;
}
const SRC = mutate(LIFTED.map(grab).join('\n\n'));

// ── Fixture ───────────────────────────────────────────────────────────────
const db = openTablesDb(DB_SRC, ['retail_customers', 'retail_points_transactions', 'storefront_config']);
const sandbox = { console, tdb: () => db };
vm.createContext(sandbox);
vm.runInContext(SRC + '\nthis.manualOrderCredit = manualOrderCredit;'
                    + '\nthis.pointsRedeemableBase = pointsRedeemableBase;'
                    + '\nthis.walletSpendForOrder = walletSpendForOrder;', sandbox);
const { manualOrderCredit } = sandbox;

const setCfg = (key, value) => db.prepare(
  'INSERT INTO storefront_config (key, value_json) VALUES (?, ?) ' +
  'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json'
).run(key, JSON.stringify(value));

let nextId = 1;
function customer({ points = 0, balance = 0 } = {}) {
  const id = nextId++;
  // `openid` is NOT NULL on the real table and is what identifies a WeChat
  // account. Filled with a per-row placeholder rather than dropped from the
  // insert: a fixture that relaxes a constraint the product enforces is a
  // fixture that stops describing the product.
  db.prepare('INSERT INTO retail_customers (id, openid, nickname, points_balance, balance) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'openid-' + id, 'C' + id, points, balance);
  return id;
}
// A counter sale: no shipping, no packing, tax already in the total.
const counter = (over) => Object.assign(
  { subtotal: 100, shippingFee: 0, packingFee: 0, taxAdded: 0, total: 100 }, over);

console.log(`\ntill credit${MUTANT ? '  [MUTANT]' : ''}\n`);

// ── Nothing asked for changes nothing ─────────────────────────────────────
it('an order that asks for no credit is untouched', () => {
  const id = customer({ points: 500, balance: 50 });
  const r = manualOrderCredit(Object.assign(counter(), { customerId: id }));
  assert.deepStrictEqual(
    [r.pointsUsed, r.pointsAmount, r.balanceUsed, r.error], [0, 0, 0, null]);
  // And the ledger is untouched — the balance is still there to spend.
  assert.strictEqual(
    db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(id).points_balance, 500);
});

// ── Points ────────────────────────────────────────────────────────────────
it('points come off at the shop\'s own redeem rate', () => {
  setCfg('points.redeemRate', 1);           // 1 point = ¥1
  const id = customer({ points: 30 });
  const r = manualOrderCredit(Object.assign(counter(), { customerId: id, pointsToUse: 30 }));
  assert.strictEqual(r.pointsUsed, 30);
  assert.strictEqual(r.pointsAmount, 30);
});

it('a rate of 100 points to the yuan is honoured, not assumed away', () => {
  setCfg('points.redeemRate', 100);
  const id = customer({ points: 2500 });
  const r = manualOrderCredit(Object.assign(counter(), { customerId: id, pointsToUse: 2500 }));
  assert.strictEqual(r.pointsAmount, 25);
  setCfg('points.redeemRate', 1);
});

it('points beyond what the bill can absorb are clamped, not burned', () => {
  const id = customer({ points: 500 });
  // The till sends the WHOLE balance and lets the server decide — so a ¥100
  // bill must take 100 points and leave 400 where they were.
  const r = manualOrderCredit(Object.assign(counter(), { customerId: id, pointsToUse: 500 }));
  assert.strictEqual(r.pointsUsed, 100);
  assert.strictEqual(r.pointsAmount, 100);
});

it('asking for more points than the customer HAS is refused, never clamped', () => {
  const id = customer({ points: 10 });
  const r = manualOrderCredit(Object.assign(counter(), { customerId: id, pointsToUse: 40 }));
  assert.ok(r.error, 'expected a refusal');
  assert.strictEqual(r.error.code, 'insufficient_points');
  assert.strictEqual(r.error.status, 409);
  assert.strictEqual(r.error.available, 10);
  // Nothing was applied on the way out.
  assert.strictEqual(r.pointsAmount, 0);
});

// ── Balance ───────────────────────────────────────────────────────────────
it('the wallet covers the bill when it is asked to', () => {
  const id = customer({ balance: 80 });
  const r = manualOrderCredit(Object.assign(counter(), { customerId: id, useBalance: true }));
  assert.strictEqual(r.balanceUsed, 80);
});

it('the wallet is capped at the bill, not at what the customer holds', () => {
  const id = customer({ balance: 500 });
  const r = manualOrderCredit(Object.assign(counter(), { customerId: id, useBalance: true }));
  assert.strictEqual(r.balanceUsed, 100);
});

it('points apply first, and the wallet only covers what is left', () => {
  const id = customer({ points: 40, balance: 500 });
  const r = manualOrderCredit(Object.assign(counter(), {
    customerId: id, pointsToUse: 40, useBalance: true }));
  assert.strictEqual(r.pointsAmount, 40);
  assert.strictEqual(r.balanceUsed, 60);
  assert.strictEqual(r.pointsAmount + r.balanceUsed, 100);
});

// ── Shipping: the hard rule and the soft one ──────────────────────────────
it('the wallet never pays shipping, and no setting lets it', () => {
  setCfg('points.coverShipping', true);   // even with the POINTS switch on
  const id = customer({ balance: 500 });
  // ¥100 of goods + ¥15 of shipping. The wallet may have the goods and not the
  // carriage, so ¥15 is left for a real tender.
  const r = manualOrderCredit(Object.assign(counter(), {
    customerId: id, useBalance: true, shippingFee: 15, total: 115 }));
  assert.strictEqual(r.balanceUsed, 100);
  setCfg('points.coverShipping', false);
});

it('points pay shipping only where the shop says so', () => {
  setCfg('points.coverShipping', false);
  const idA = customer({ points: 500 });
  const off = manualOrderCredit(Object.assign(counter(), {
    customerId: idA, pointsToUse: 500, shippingFee: 15, total: 115 }));
  assert.strictEqual(off.pointsAmount, 100, 'shipping excluded by default');

  setCfg('points.coverShipping', true);
  const idB = customer({ points: 500 });
  const on = manualOrderCredit(Object.assign(counter(), {
    customerId: idB, pointsToUse: 500, shippingFee: 15, total: 115 }));
  assert.strictEqual(on.pointsAmount, 115, 'shipping included when the shop allows it');
  setCfg('points.coverShipping', false);
});

// ── The override cap — the case the checkout never has ────────────────────
it('a grand-total override caps the credit at the bill actually due', () => {
  const id = customer({ points: 500 });
  // ¥100 of goods, overridden down to ¥5. Redeeming against the goods would
  // hand back ¥95 of credit the shop never charged for.
  const r = manualOrderCredit(Object.assign(counter(), {
    customerId: id, pointsToUse: 500, total: 5 }));
  assert.strictEqual(r.pointsAmount, 5);
  assert.strictEqual(r.pointsUsed, 5);
});

it('an override caps the wallet the same way', () => {
  const id = customer({ balance: 500 });
  const r = manualOrderCredit(Object.assign(counter(), {
    customerId: id, useBalance: true, total: 5 }));
  assert.strictEqual(r.balanceUsed, 5);
});

// ── Who may spend it ──────────────────────────────────────────────────────
it('a guest walk-in is refused, not charged in full as though it applied', () => {
  const r = manualOrderCredit(Object.assign(counter(), {
    customerId: null, pointsToUse: 50 }));
  assert.ok(r.error, 'expected a refusal');
  assert.strictEqual(r.error.code, 'credit_requires_customer');
  assert.strictEqual(r.error.status, 400);
});

it('a guest who asks for nothing is not refused either', () => {
  const r = manualOrderCredit(Object.assign(counter(), { customerId: null }));
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.pointsAmount, 0);
});

// ── A free order takes no credit ──────────────────────────────────────────
it('a bill of nothing spends nothing', () => {
  const id = customer({ points: 500, balance: 500 });
  const r = manualOrderCredit(Object.assign(counter(), {
    customerId: id, pointsToUse: 500, useBalance: true, subtotal: 0, total: 0 }));
  assert.strictEqual(r.pointsAmount, 0);
  assert.strictEqual(r.balanceUsed, 0);
});

// ── The route's own wiring, read from source ──────────────────────────────
// The arithmetic above is worth nothing if the route never calls it, spends the
// credit outside its transaction, or forgets to write the columns a refund is
// later split by. Those are properties of the call site, not of the function.
const ROUTE = (() => {
  const i = RETAIL_SRC.indexOf("router.post('/api/retail-admin/orders'");
  assert.ok(i > 0, 'the manual-order route was not found');
  const j = RETAIL_SRC.indexOf("router.post('/api/retail-admin/order-drafts'", i);
  assert.ok(j > i, 'the end of the manual-order route was not found');
  return RETAIL_SRC.slice(i, j);
})();

it('the route asks manualOrderCredit rather than deciding for itself', () => {
  assert.ok(/const credit = manualOrderCredit\(\{/.test(ROUTE),
            'the route does not call manualOrderCredit');
  // And there is exactly one such decision on this path.
  assert.strictEqual((ROUTE.match(/manualOrderCredit\(/g) || []).length, 1);
});

it('the credit comes off the total, so the cash figure is the residual', () => {
  assert.ok(/total = Math\.max\(0, money\.round\(total - credit\.pointsAmount - credit\.balanceUsed\)\)/.test(ROUTE),
            'the credit is not subtracted from the total');
});

it('both tenders are stored on the order, so a refund can be split across them', () => {
  assert.ok(/points_used, points_amount, balance_used/.test(ROUTE),
            'the INSERT does not carry the credit columns');
  assert.ok(/credit\.pointsUsed, credit\.pointsAmount, credit\.balanceUsed/.test(ROUTE),
            'the INSERT does not bind the credit values');
});

it('the spend happens INSIDE the order transaction, on the tx handle', () => {
  // `tx.prepare`, never `tdb().prepare`: the second would take the deduction
  // outside the transaction the order is being written in, where a rollback
  // could no longer put the points back.
  const spend = ROUTE.slice(ROUTE.indexOf('if (credit.pointsUsed > 0)'));
  assert.ok(spend.startsWith('if (credit.pointsUsed > 0)'), 'the points spend was not found');
  const upToBalance = spend.slice(0, spend.indexOf('return orderId;'));
  assert.ok(!/tdb\(\)\.prepare/.test(upToBalance),
            'the credit is spent on the pool handle, outside the transaction');
  assert.ok((upToBalance.match(/tx\.prepare/g) || []).length >= 4,
            'the credit spend does not use the transaction handle');
});

it('each deduction floor-checks in the same statement that writes it', () => {
  assert.ok(/SET points_balance = points_balance - \? WHERE id = \? AND points_balance >= \?/.test(ROUTE),
            'the points deduction is not atomic');
  assert.ok(/SET balance = ROUND\(COALESCE\(balance, 0\) - \?, 2\) WHERE id = \? AND ROUND\(COALESCE\(balance, 0\) - \?, 2\) >= 0/.test(ROUTE),
            'the balance deduction is not atomic');
});

it('a lost race answers 409, not 500', () => {
  assert.ok(/if \(creditError\) return res\.status\(409\)/.test(ROUTE),
            'a failed floor check does not become a 409');
});

it('both spends are ledgered where the refund path looks for them', () => {
  assert.ok(/'order_redeem', \?, \?\)/.test(ROUTE) || /source, order_id, note\)[\s\S]{0,200}'order_redeem'/.test(ROUTE),
            'the points spend is not ledgered as order_redeem');
  // reverseOrderBalance finds the wallet spend by this exact tag.
  assert.ok(/orderspend:\$\{orderId\}/.test(ROUTE),
            'the wallet spend is not tagged the way reverseOrderBalance reads it');
});

/* ── THE ROW SHAPE, WHICH IS WHAT THIS SUITE MISSED FIRST TIME (§95) ──────
   Everything else in this file asserted the ARITHMETIC and the WIRING, and all
   of it passed while pay-with-points was dead in production: the till read
   `c.points` off a customer row that has only ever carried `points_balance`,
   so `creditOffer` saw zero points for everybody and the control never drew.
   The wallet worked purely because its column is spelled `balance`.

   No assertion here knew what a real row looks like — they all built their own.
   These three close that: the endpoint's own SELECT is read for the field name,
   the normaliser is RUN against a row shaped like the endpoint's, and
   creditOffer is RUN against the result. A test that invents its input cannot
   catch an input it invented wrongly. */
const CUST_LIST_SELECT = (() => {
  const i = RETAIL_SRC.indexOf("router.get('/api/retail-admin/customers'");
  assert.ok(i > 0, 'the customer list route was not found');
  const sel = RETAIL_SRC.indexOf('SELECT id, nickname', i);
  assert.ok(sel > i, 'the customer list SELECT was not found');
  return RETAIL_SRC.slice(sel, RETAIL_SRC.indexOf('LIMIT ? OFFSET ?', sel));
})();

it('the customer list still returns points_balance, not points', () => {
  assert.ok(/\bpoints_balance\b/.test(CUST_LIST_SELECT),
            'the endpoint no longer selects points_balance — the till normaliser needs updating');
  assert.ok(!/\bAS points\b/.test(CUST_LIST_SELECT),
            'the endpoint now aliases points — the normaliser and this test disagree');
});

// The two till functions, lifted and run.
const tillFn = (name) => {
  const m = new RegExp(`^  function ${name}\\(`, 'm').exec(TILL_SRC);
  assert.ok(m, `function ${name} not found in till.html`);
  let i = TILL_SRC.indexOf('{', TILL_SRC.indexOf(')', m.index)), depth = 0;
  for (; i < TILL_SRC.length; i++) {
    const c = TILL_SRC[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return TILL_SRC.slice(m.index, i + 1);
};

it('the normaliser turns an endpoint row into one the screen can read', () => {
  const custRow = new Function(`${tillFn('custRow')}\nreturn custRow;`)();
  // Exactly what /api/retail-admin/customers hands back: the column names.
  const row = custRow({ id: 7, nickname: 'Ada', points_balance: 240, balance: 174.51 });
  assert.strictEqual(row.points, 240, 'points_balance did not become points');
  assert.strictEqual(row.balance, 174.51);
  // A null balance is a real state for a customer who has never topped up.
  assert.deepStrictEqual(
    [custRow({ points_balance: null, balance: null }).points,
     custRow({ points_balance: null, balance: null }).balance], [0, 0]);
});

it('a customer with points is offered them — the case that was dead in production', () => {
  const custRow = new Function(`${tillFn('custRow')}\nreturn custRow;`)();
  const offer = new Function('S', 'settleDue', `${tillFn('creditOffer')}\nreturn creditOffer;`);
  const run = (customer, useP) => offer(
    { recall: null, customer, pts: { rate: 1, coverShipping: false }, useP: !!useP, useB: false },
    () => 100)();
  const c = custRow({ id: 7, nickname: 'Ada', points_balance: 240, balance: 0 });
  assert.strictEqual(run(c).pMax, 100, 'the points offer is not clamped to the bill');
  assert.strictEqual(run(c, true).pAmt, 100, 'points switched on took nothing off');
  // And the raw endpoint row, WITHOUT the normaliser, is the broken case — so
  // this assertion fails the moment the boundary stops normalising.
  assert.strictEqual(
    run({ id: 7, points_balance: 240, balance: 0 }).pMax, 0,
    'an un-normalised row now offers points — the fixture no longer proves the boundary matters');
});

// ── The till's half ───────────────────────────────────────────────────────
it('the till sends the whole offer and lets the server clamp it', () => {
  assert.ok(/out\.points_to_use = cr\.pMax/.test(TILL_SRC),
            'the till does not send its points offer');
  assert.ok(/out\.use_balance = true/.test(TILL_SRC),
            'the till does not send its balance flag');
});

it('the till states the residual, not the gross', () => {
  assert.ok(/function cashDue\(\)/.test(TILL_SRC), 'cashDue is missing');
  assert.ok(/var due = cashDue\(\);[\s\S]{0,200}var cr = creditOffer\(\);/.test(TILL_SRC),
            'the settle screen does not state the cash residual');
});

it('a fully covered bill records the credit as its tender, never offline', () => {
  assert.ok(/body\.payment_method = creditTender\(\)/.test(TILL_SRC),
            'the till does not name the credit tender');
  assert.ok(/return cr\.pAmt > 0 \? 'points' : 'balance';/.test(TILL_SRC),
            'creditTender does not resolve to a real tender');
});

it('credit is never offered on a recalled QR order', () => {
  // The recall settles by PATCHing status; credit chosen here would be shown,
  // charged as though it applied, and never deducted.
  assert.ok(/if \(S\.recall \|\| !S\.customer\) return out;/.test(TILL_SRC),
            'creditOffer does not stand down on a recall');
});

it('the toggles clear with the customer they belong to', () => {
  assert.ok(/S\.customer = null; S\.useP = false; S\.useB = false;/.test(TILL_SRC),
            'removing the customer leaves their credit selected');
  assert.ok(/S\.customer = c; S\.useP = false; S\.useB = false;/.test(TILL_SRC),
            'attaching a customer inherits the previous one\'s selection');
  assert.strictEqual((TILL_SRC.match(/S\.wallet = null; S\.useP = false; S\.useB = false;/g) || []).length, 3,
    'a reset path clears the wallet but leaves the credit toggles set');
});

/* ══════════════════════════════════════════════════════════════════════════
   THE ROUTE ITSELF, RUN — not read.

   Everything above this line either exercises manualOrderCredit on its own or
   READS the call site. Neither can tell you that a sale actually moves the
   customer's balance: the first never opens a transaction, and the second is a
   regular expression, which is the class of assertion this repository has twice
   found passing over code that did nothing (decisions v4.196, v4.154).

   So the REAL handler is lifted whole and driven, over a real schema, with the
   real transaction helper — the technique test_tax.js and
   test_tx_conversion_manual_order.js use on this same route. What is proven
   here is the only thing that matters at the counter: the points come off, the
   wallet comes off, the ledgers say where they went, and the cash figure the
   card machine is handed is what is left.
   ══════════════════════════════════════════════════════════════════════════ */
const { openTablesDb: openTables2, addForkedStoreProducts } = require('./test-support/memory-db');
const { withTransaction } = require('../lib/db-transaction');
const SCHEMA_SRC = read('schema.sql');
const HANDLER_ANCHOR =
  "router.post('/api/retail-admin/orders', requireRetailAdmin, express.json(), async (req, res) => {";

function sliceHandler() {
  const i = RETAIL_SRC.indexOf(HANDLER_ANCHOR);
  assert.notStrictEqual(i, -1, 'the create handler anchor did not match — the route changed shape');
  const from = i + HANDLER_ANCHOR.length;
  const m = /\r?\n\}\);/.exec(RETAIL_SRC.slice(from));
  assert.ok(m, 'the handler is unterminated');
  return RETAIL_SRC.slice(from, from + m.index);
}
// Shallower than grab() above and matching what the sibling suites use: these
// callees have no `\n}` inside them.
function extractFunction(name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(RETAIL_SRC);
  assert.ok(m, `function ${name} not found`);
  const end = RETAIL_SRC.indexOf('\n}', m.index);
  assert.notStrictEqual(end, -1, `unterminated function ${name}`);
  return RETAIL_SRC.slice(m.index, end + 2);
}
const BODY = sliceHandler();

function liveFixture() {
  const d = openTables2(DB_SRC, ['retail_customers', 'retail_orders', 'retail_order_items',
                                 'retail_payments', 'retail_stores', 'storefront_config',
                                 'retail_points_transactions', 'retail_topup_transactions']);
  addForkedStoreProducts(d, SCHEMA_SRC, DB_SRC);
  d.prepare("INSERT INTO store_products (id, name_en, name_cn, sku, weight, sell_price, is_active) VALUES (1,'Tofu','豆腐','SKU1','500g',50,1)").run();
  d.prepare("INSERT INTO retail_stores (id, code, name_en) VALUES (1, 'MAIN', 'Main')").run();
  return d;
}

function handlerFor(d) {
  const money = require(path.join(ROOT, 'lib', 'money'));
  const taxLib = require(path.join(ROOT, 'lib', 'tax'));
  const scope = {
    tdb: () => d,
    withTransaction,
    crypto: require('crypto'),
    MANUAL_ORDER_CHANNELS: ['manual', 'shop', 'pickup', 'wechat_chat', 'wholesale', 'other'],
    SHOP_ENTRY_METHODS: ['till', 'qr'],
    ORDER_FULFILLMENT_TYPES: ['delivery', 'pickup', 'counter'],
    createOrReuseManualCustomer: new Function('tdb', 'crypto', 'normEmail',
      `${extractFunction('createOrReuseManualCustomer')}\nreturn createOrReuseManualCustomer;`
    )(() => d, require('crypto'), (e) => (e == null ? '' : String(e).trim().toLowerCase())),
    nextOrderNo: new Function('tdb', `${extractFunction('nextOrderNo')}\nreturn nextOrderNo;`)(() => d),
    resolveManualOrderLines: new Function('tdb', 'productUnitCostYuan',
      `${extractFunction('costAtSale')}\n${extractFunction('resolveManualOrderLines')}\nreturn resolveManualOrderLines;`
    )(() => d, require(path.join(ROOT, 'lib', 'product-cost')).productUnitCostYuan),
    posClosedForStore: new Function('tdb', `${extractFunction('posClosedForStore')}\nreturn posClosedForStore;`)(() => d),
    taxSettings: new Function('tdb', 'tax', `${extractFunction('taxSettings')}\nreturn taxSettings;`)(() => d, taxLib),
    // The subject. Real, with its whole chain.
    manualOrderCredit: new Function('tdb', mutate([
      'cfgValue', 'pointsRedeemRate', 'pointsCashValue', 'pointsRequiredFor',
      'pointsCoverShipping', 'pointsRedeemableBase', 'walletSpendableBase',
      'walletSpendForOrder', 'sweepExpiredPoints',
    ].map(extractFunction).join('\n') + '\n' + grab('manualOrderCredit'))
      + '\nreturn manualOrderCredit;')(() => d),
    tax: taxLib, money,
    geocodeOrderSnapshotAsync: () => {},
    claimMigrationCredit: () => null,
    reconcileSignupVouchers: () => 0,
    logActivity: () => {},
    // Deliberately inert: what markOrderPaid does on the paid transition is its
    // own suite's subject. What this file asks is what the CREATE wrote.
    markOrderPaid: () => {},
  };
  const keys = Object.keys(scope);
  return new Function(...keys, `return async (req, res) => {${BODY}};`)(...keys.map((k) => scope[k]));
}

// One till sale, exactly as public/till.html posts it.
async function sell(d, body) {
  const res = { code: 200, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  await handlerFor(d)({
    body: Object.assign({
      items: [{ product_id: 1, qty: 2 }],        // 2 × ¥50 = ¥100
      recipient_name: 'Ada', fulfillment_type: 'counter', store_id: 1,
      channel: 'shop', shop_entry_method: 'till', status: 'paid',
      payment_method: 'wechat_offline',
    }, body),
    user: { id: 42, username: 'op' }, tenant: null, caps: null,
    ip: '127.0.0.1', protocol: 'https', get: () => 'shop.example.com',
  }, res);
  return { res, row: d.prepare('SELECT * FROM retail_orders ORDER BY id DESC LIMIT 1').get() };
}
const liveCustomer = (d, { points = 0, balance = 0 }) => {
  d.prepare('INSERT INTO retail_customers (id, openid, nickname, points_balance, balance) VALUES (1, \'o1\', \'Ada\', ?, ?)')
    .run(points, balance);
  return 1;
};

(async () => {
  console.log('\nthrough the real route\n');

  await (async () => {
    const d = liveFixture();
    const id = liveCustomer(d, { points: 30, balance: 20 });
    const { res, row } = await sell(d, { customer_id: id, points_to_use: 30, use_balance: true });
    it('a part-credit sale charges only what is left', () => {
      assert.strictEqual(res.code, 200);
      assert.strictEqual(row.total, 50);              // 100 − 30 points − 20 wallet
      assert.strictEqual(row.points_used, 30);
      assert.strictEqual(row.points_amount, 30);
      assert.strictEqual(row.balance_used, 20);
    });
    it('and the customer is actually poorer by exactly that', () => {
      const c = d.prepare('SELECT points_balance, balance FROM retail_customers WHERE id = 1').get();
      assert.strictEqual(c.points_balance, 0);
      assert.strictEqual(c.balance, 0);
    });
    it('the payment row asks for the residual, not the whole bill', () => {
      const pay = d.prepare('SELECT method, amount FROM retail_payments ORDER BY id DESC LIMIT 1').get();
      assert.strictEqual(pay.amount, 50);
      assert.strictEqual(pay.method, 'wechat_offline');
    });
    it('both spends are ledgered where a refund will look for them', () => {
      const pts = d.prepare("SELECT delta, source FROM retail_points_transactions WHERE order_id = ?").get(row.id);
      assert.deepStrictEqual([pts.delta, pts.source], [-30, 'order_redeem']);
      const wal = d.prepare("SELECT amount, payment_method FROM retail_topup_transactions WHERE out_trade_no = ?")
        .get('orderspend:' + row.id);
      assert.deepStrictEqual([wal.amount, wal.payment_method], [-20, 'order_redeem']);
    });
    it('and the three tenders add back up to the sale', () => {
      assert.strictEqual(row.points_amount + row.balance_used + row.total, 100);
    });
  })();

  await (async () => {
    const d = liveFixture();
    const id = liveCustomer(d, { points: 500 });
    const { res, row } = await sell(d, { customer_id: id, points_to_use: 500, payment_method: 'points' });
    it('credit covering the whole bill leaves nothing for a wallet', () => {
      assert.strictEqual(res.code, 200);
      assert.strictEqual(row.total, 0);
      assert.strictEqual(row.points_amount, 100);
      // And the shop kept the 400 points the bill could not absorb.
      assert.strictEqual(
        d.prepare('SELECT points_balance FROM retail_customers WHERE id = 1').get().points_balance, 400);
    });
    it('and the order names the credit as its tender, never offline', () => {
      assert.strictEqual(row.payment_method, 'points');
    });
    it('a bill with nothing left to pay is offered no pay link', () => {
      assert.strictEqual(res.body.data.pay_url, null);
    });
  })();

  /* The word has to be earned. This is the ORIGINAL untruth — the one that made
     'points' a label rather than a tender — and adding the deduction does not
     close it on its own: a caller can still send the word with no
     `points_to_use` behind it. */
  await (async () => {
    const d = liveFixture();
    const id = liveCustomer(d, { points: 500 });
    const { res } = await sell(d, { customer_id: id, payment_method: 'points' });
    it('claiming points paid for it, with no points spent, is refused', () => {
      assert.strictEqual(res.code, 400);
      assert.strictEqual(res.body.error, 'credit_did_not_settle');
      assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM retail_orders').get().n, 0);
    });
  })();

  await (async () => {
    const d = liveFixture();
    const id = liveCustomer(d, { points: 30 });
    // ¥30 of a ¥100 bill. Credit was real, but a wallet still has ¥70 to take,
    // so the tender is the wallet's name and not the credit's.
    const { res } = await sell(d, { customer_id: id, points_to_use: 30, payment_method: 'points' });
    it('and so is claiming it when credit only covered part of the bill', () => {
      assert.strictEqual(res.code, 400);
      assert.strictEqual(res.body.error, 'credit_did_not_settle');
      assert.strictEqual(res.body.due, 70);
    });
  })();

  await (async () => {
    const d = liveFixture();
    const id = liveCustomer(d, { points: 10 });
    const { res } = await sell(d, { customer_id: id, points_to_use: 40 });
    it('a stale points balance is refused, and NOTHING is written', () => {
      assert.strictEqual(res.code, 409);
      assert.strictEqual(res.body.error, 'insufficient_points');
      assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM retail_orders').get().n, 0);
      // The refusal did not cost the customer their points either.
      assert.strictEqual(
        d.prepare('SELECT points_balance FROM retail_customers WHERE id = 1').get().points_balance, 10);
    });
  })();

  await (async () => {
    const d = liveFixture();
    const { res } = await sell(d, { points_to_use: 40 });   // no customer_id: a walk-in
    it('a guest asking to spend points is refused, and no order is left behind', () => {
      assert.strictEqual(res.code, 400);
      assert.strictEqual(res.body.error, 'credit_requires_customer');
      assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM retail_orders').get().n, 0);
    });
  })();

  await (async () => {
    const d = liveFixture();
    const id = liveCustomer(d, { points: 500, balance: 500 });
    const { res, row } = await sell(d, { customer_id: id });
    it('a sale that asks for no credit is the sale it always was', () => {
      assert.strictEqual(res.code, 200);
      assert.strictEqual(row.total, 100);
      assert.deepStrictEqual([row.points_used, row.points_amount, row.balance_used], [0, 0, 0]);
      const c = d.prepare('SELECT points_balance, balance FROM retail_customers WHERE id = 1').get();
      assert.deepStrictEqual([c.points_balance, c.balance], [500, 500]);
      assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM retail_points_transactions').get().n, 0);
    });
  })();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
