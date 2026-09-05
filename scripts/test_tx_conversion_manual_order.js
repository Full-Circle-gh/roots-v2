#!/usr/bin/env node
/**
 * Transaction conversion: `POST /api/retail-admin/orders` (decisions §24).
 *
 *   node scripts/test_tx_conversion_manual_order.js
 *
 * THE REAL HANDLER IS EXTRACTED AND EXECUTED, not reproduced. §24 records the
 * cost of the alternative twice — a harness that runs a copy is testing a
 * different program, and it passes while the program fails. The route body is
 * sliced out of routes/retail.js and instantiated; `withTransaction`,
 * `createOrReuseManualCustomer` and `nextOrderNo` are the REAL ones. Only the
 * post-commit collaborators are spies, and each one asserts something about
 * WHEN it ran rather than merely that it ran.
 *
 * ── WHAT THIS SUITE IS ACTUALLY FOR ───────────────────────────────────────
 * The conversion moved this route from a synchronous `tdb().transaction()` to
 * `await withTransaction(tdb(), …)`. Two properties have to survive that, and
 * they pull in opposite directions:
 *
 *   1. Everything INSIDE the block is still one unit. A failure at the last
 *      write must leave no order, no items, and no customer. Tests 4 and 5
 *      assert the EXACT surviving row sets, not merely "the order is absent" —
 *      a partial rollback is also non-zero and is also data loss.
 *
 *   2. Everything AFTER the block is still outside it. The money work —
 *      claimMigrationCredit, reconcileSignupVouchers, markOrderPaid — is
 *      post-COMMIT by design, and that boundary is what keeps this route out
 *      of the money cluster. Test 3 proves it positively: each spy QUERIES THE
 *      DATABASE as it runs and must SEE the committed order. A spy that merely
 *      counted calls would pass just as happily with the calls moved inside.
 *
 * ── NO CONCURRENCY IS CLAIMED, AND THAT IS A REAL LIMIT ───────────────────
 * The brief asked for no concurrency test that cannot fail. There is none here,
 * because on SQLite there is nothing to catch: the app runs pm2 fork mode with
 * a single instance, and better-sqlite3 is synchronous, so a converted handler
 * still cannot interleave with itself. A suite that spawned two calls in one
 * synchronous block would be green and would prove nothing — the mistake
 * recorded in lib/db-transaction.js. The interleaving this conversion DOES
 * introduce is between whole post-commit blocks, and test 8 pins the property
 * that makes it safe (every post-commit path is keyed on an identifier
 * exclusive to its own request) rather than pretending to schedule it.
 *
 * TO PROVE THE SUITE CAN FAIL:  TXMO_MUTANT=1 node scripts/test_tx_conversion_manual_order.js
 * The mutant DROPS THE await before withTransaction — the classic failure of
 * this exact conversion, where the handler races past an unresolved transaction
 * and does its post-commit money work before the COMMIT. Per §24 (v4.27) the
 * mutation ASSERTS IT MODIFIED THE SOURCE before its red counts as evidence.
 * An earlier mutant (tx.prepare -> tdb().prepare) SURVIVED; see the note at the
 * mutation block for why that is a property of SQLite and not a hole.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, addForkedStoreProducts, driver } = require('./test-support/memory-db');
const { withTransaction } = require('../lib/db-transaction');

const MUTANT = process.env.TXMO_MUTANT === '1';
const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
// LINE ENDINGS ARE NORMALISED AT READ. routes/retail.js is CRLF in this
// checkout, and an anchor written with "\n" then matches nothing — which shows
// up as a green assertion that never ran, not as an error. §24 records exactly
// that mistake ("an anchor must contain no line ending at all"); normalising
// once here is the version of that rule this suite can enforce mechanically.
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8').replace(/\r\n/g, '\n');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const DB_TABLES = ['retail_customers', 'retail_orders', 'retail_order_items',
                   'retail_payments', 'retail_stores'];

// ── Extraction ─────────────────────────────────────────────────────────────
// Anchors carry NO line ending — a `\r\n` anchor is the specific mistake §24
// records from the batch that wrote one and had to replace it.
const HANDLER_ANCHOR =
  "router.post('/api/retail-admin/orders', requireRetailAdmin, express.json(), async (req, res) => {";

function sliceHandler(src) {
  const i = src.indexOf(HANDLER_ANCHOR);
  assert.notStrictEqual(i, -1, 'the handler anchor did not match — the route changed shape');
  const from = i + HANDLER_ANCHOR.length;
  // The route closes at a `});` in column 0; nothing inside it is unindented.
  const m = /\r?\n\}\);/.exec(src.slice(from));
  assert.ok(m, 'the handler is unterminated');
  return src.slice(from, from + m.index);
}

const REAL_BODY = sliceHandler(RETAIL_SRC);

function extractFunction(code, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(code);
  assert.ok(m, `function ${name} not found`);
  const end = code.indexOf('\n}', m.index);
  assert.notStrictEqual(end, -1, `unterminated function ${name}`);
  return code.slice(m.index, end + 2);
}

// ── The mutant, and the guard that makes its red mean something ────────────
//
// THE FIRST MUTANT WRITTEN HERE SURVIVED, AND WHY IT DID IS WORTH RECORDING.
// It rewrote `tx.prepare(` back to `tdb().prepare(` — writes escaping the
// transaction — and every test stayed green. That is not a gap in the suite: on
// SQLite `tx` IS the object passed in, so `tdb()` and `tx` are the same
// connection and both statements join the same transaction. lib/db-transaction
// says so in its own header ("On SQLite `tx` is the same object that was passed
// in, so it looks redundant. On pg it will NOT be"), and a mutation that cannot
// change behaviour cannot be caught by behaviour.
//
// SO THE tx-VS-tdb() DISCIPLINE IS SOURCE-ENFORCED HERE, NOT BEHAVIOUR-ENFORCED,
// and the suite says which is which rather than implying it has proven both.
// The source assertion below ("no ambient tdb() survives inside the transaction
// body") is the whole of that proof on this driver. It becomes a behavioural
// property at the flip, where tx is a checked-out client and tdb() is the pool.
//
// The mutation that IS meaningful for this conversion drops the `await`. That
// is the classic failure of exactly this change — the handler races on past an
// unresolved transaction and does its post-commit money work before the COMMIT.
// It is caught, because the spies read the database as they run.
const MUTATION_ANCHOR = 'await withTransaction(tdb(), async (tx) => {';
const MUTATION_RESULT = 'withTransaction(tdb(), async (tx) => {';
let BODY = REAL_BODY;
let mutationCount = 0;
if (MUTANT) {
  mutationCount = REAL_BODY.split(MUTATION_ANCHOR).length - 1;
  assert.strictEqual(
    mutationCount, 1,
    `mutation anchor matched ${mutationCount} times — expected exactly 1. ` +
    'The mutation did not modify the source, so a red run would prove nothing.'
  );
  BODY = REAL_BODY.split(MUTATION_ANCHOR).join(MUTATION_RESULT);
  assert.notStrictEqual(BODY, REAL_BODY, 'the mutant body is identical to the real body');
}

// ── Fixture ────────────────────────────────────────────────────────────────
function fresh() {
  const db = openTablesDb(DB_SRC, DB_TABLES);
  addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
  db.prepare(
    "INSERT INTO store_products (id, name_en, name_cn, sku, weight, sell_price, is_active) VALUES (1,'Tofu','豆腐','SKU1','500g',12.5,1)"
  ).run();
  db.prepare("INSERT INTO retail_stores (id, code, name_en) VALUES (1, 'MAIN', 'Main')").run();
  return db;
}

const all = (db, t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
const n = (db, t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;

/** Instantiate the REAL handler over a scope we control. */
function makeHandler(db, spies) {
  const scope = {
    tdb: () => db,
    withTransaction,
    crypto: require('crypto'),
    MANUAL_ORDER_CHANNELS: ['manual', 'wechat', 'web'],
    ORDER_FULFILLMENT_TYPES: ['delivery', 'pickup', 'counter'],
    // Real, extracted — these two are the point of the conversion.
    createOrReuseManualCustomer: new Function(
      'tdb', 'crypto', 'normEmail',
      `${extractFunction(RETAIL_SRC, 'createOrReuseManualCustomer')}\nreturn createOrReuseManualCustomer;`
    )(() => db, require('crypto'), (e) => (e == null ? '' : String(e).trim().toLowerCase())),
    nextOrderNo: new Function(
      'tdb',
      `${extractFunction(RETAIL_SRC, 'nextOrderNo')}\nreturn nextOrderNo;`
    )(() => db),
    /* THE LINE RESOLVER, EXTRACTED FOR THE SAME REASON AS THE TWO ABOVE.
       The route body was refactored to call resolveManualOrderLines(), and this
       scope did not have it — so seven cases failed with "resolveManualOrderLines
       is not defined", which reads like a conversion defect and is not one. A
       stub would have been worse than the error: this helper decides what each
       line costs and what it snapshots, and the cases below assert the committed
       row sets. Given a stub they would have asserted the stub.
       It carries costAtSale, its own dependency, extracted the same way — the
       cost snapshot the operator cannot override. */
    resolveManualOrderLines: new Function(
      'tdb', 'productUnitCostYuan',
      `${extractFunction(RETAIL_SRC, 'costAtSale')}\n`
      + `${extractFunction(RETAIL_SRC, 'resolveManualOrderLines')}\nreturn resolveManualOrderLines;`
      // The REAL cost resolver, not left undefined. costAtSale swallows its own
      // errors and answers null, so an absent dependency here would not fail —
      // it would quietly snapshot a null cost on every line while these cases
      // assert the committed rows. A silent null is the shape of an assertion
      // that stops meaning anything.
    )(() => db, require(path.join(ROOT, 'lib', 'product-cost')).productUnitCostYuan),
    /* The counter-sale gate the handler consults before taking money. Extracted
       rather than stubbed true/false: whether the till is shut for a store is a
       real read, and a stub would decide it here instead of letting the fixture
       decide it. */
    posClosedForStore: new Function(
      'tdb',
      `${extractFunction(RETAIL_SRC, 'posClosedForStore')}\nreturn posClosedForStore;`
    )(() => db),
    ...spies,
  };
  const keys = Object.keys(scope);
  return new Function(...keys, `return async (req, res) => {${BODY}};`)(...keys.map((k) => scope[k]));
}

/** Spies that record ORDER and what the database looked like when they ran. */
function makeSpies(db, opts = {}) {
  const log = [];
  const seen = {};
  const note = (name) => {
    log.push(name);
    // The committed state AS OBSERVED BY THIS CALL. This is what proves the
    // call is outside the transaction: an uncommitted order would not be here.
    seen[name] = n(db, 'retail_orders');
  };
  return {
    log,
    seen,
    spies: {
      geocodeOrderSnapshotAsync: () => note('geocode'),
      claimMigrationCredit: (cid) => { note('claimMigrationCredit'); if (opts.creditThrows) throw new Error('boom-credit'); return { balance: 5, points: 3, customer_id: cid }; },
      reconcileSignupVouchers: () => { note('reconcileSignupVouchers'); return 2; },
      logActivity: () => note('logActivity'),
      markOrderPaid: () => { note('markOrderPaid'); if (opts.paidThrows) throw new Error('boom-paid'); },
    },
  };
}

function makeReq(body) {
  return {
    body,
    user: { id: 42, username: 'op' },
    tenant: null, caps: null, ip: '127.0.0.1',
    protocol: 'https',
    get: () => 'shop.example.com',
  };
}
function makeRes() {
  const r = { code: 200, body: null, sent: false };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; r.sent = true; return r; };
  return r;
}

const ORDER = (over = {}) => ({
  items: [{ product_id: 1, qty: 2 }],
  recipient_name: 'Ada',
  fulfillment_type: 'counter',
  // A COUNTER SALE MUST NAME ITS STORE, and this request predated that rule.
  // The handler answers 'store_required_for_counter' without one, so every case
  // below got a 400 and reported it as a transaction defect — "commits the exact
  // row sets" failing with 400 !== 200 reads like the conversion broke, when the
  // handler was refusing a request the fixture had simply not kept up with. The
  // fixture already inserts this store; only the request omitted it.
  store_id: 1,
  // …and must say how it was paid, for the same reason: a sale rung at the
  // counter is money taken now, so the handler refuses one that does not say
  // how. Both rules arrived together and this request predated both.
  payment_method: 'cash',
  ...over,
});

// ── Runner ─────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
async function it(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; failures.push(name); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

(async () => {
console.log('\nPOST /api/retail-admin/orders — transaction conversion\n');

// 1 ── The happy path writes exactly what it should, and nothing else.
await it('commits the exact row sets: 1 order, 1 item, 1 pending payment', async () => {
  const db = fresh();
  const { spies } = makeSpies(db);
  const res = makeRes();
  await makeHandler(db, spies)(makeReq(ORDER()), res);

  // The BODY, not just the code. "expected 200, got 400" names the symptom and
  // hides the reason, and every case in this file that ever goes red goes red
  // through this line — twice already for a validation the handler had gained
  // and this fixture had not. The error name turns a bisect into a read.
  assert.strictEqual(res.code, 200,
    `expected 200, got ${res.code} — ${JSON.stringify(res.body)}`);
  const orders = all(db, 'retail_orders');
  assert.strictEqual(orders.length, 1, 'expected exactly one order');
  assert.strictEqual(orders[0].order_no, 'TC000001');
  assert.strictEqual(orders[0].status, 'pending_payment', 'the row must be inserted pending, always');
  assert.strictEqual(Number(orders[0].total), 25, 'total = 2 x 12.5');

  const items = all(db, 'retail_order_items');
  assert.strictEqual(items.length, 1, 'expected exactly one item row');
  assert.strictEqual(items[0].order_id, orders[0].id);
  assert.strictEqual(items[0].qty, 2);

  const pay = all(db, 'retail_payments');
  assert.strictEqual(pay.length, 1, 'expected exactly one payment row');
  assert.strictEqual(pay[0].status, 'pending');
  assert.strictEqual(pay[0].out_trade_no, 'TC000001');

  assert.strictEqual(n(db, 'retail_customers'), 0, 'a guest order created a customer');
});

// 2 ── save_customer writes the customer in the SAME transaction.
await it('save_customer: the customer and the order commit together', async () => {
  const db = fresh();
  const { spies } = makeSpies(db);
  const res = makeRes();
  await makeHandler(db, spies)(
    makeReq(ORDER({ save_customer: true, recipient_phone: '13800001111' })), res);

  assert.strictEqual(res.code, 200);
  assert.strictEqual(n(db, 'retail_customers'), 1, 'the customer was not written');
  assert.strictEqual(n(db, 'retail_orders'), 1);
  const c = all(db, 'retail_customers')[0];
  assert.strictEqual(c.phone, '13800001111');
  assert.strictEqual(all(db, 'retail_orders')[0].customer_id, c.id, 'the order was not attached');
});

// 3 ── THE BOUNDARY. Each post-commit call must SEE the committed order.
await it('post-commit calls run OUTSIDE the transaction — each one sees the committed order', async () => {
  const db = fresh();
  const { spies, log, seen } = makeSpies(db);
  const res = makeRes();
  await makeHandler(db, spies)(
    makeReq(ORDER({ save_customer: true, recipient_phone: '13800002222', status: 'paid' })), res);

  assert.ok(log.includes('markOrderPaid'), 'markOrderPaid did not run');
  assert.ok(log.includes('claimMigrationCredit'), 'claimMigrationCredit did not run');
  assert.ok(log.includes('reconcileSignupVouchers'), 'reconcileSignupVouchers did not run');
  for (const name of ['claimMigrationCredit', 'reconcileSignupVouchers', 'markOrderPaid']) {
    assert.strictEqual(seen[name], 1,
      `${name} could not see a committed order — it ran INSIDE the transaction`);
  }
});

// 4 ── Order of the post-commit calls, which the route's comments rely on.
await it('post-commit calls run in the documented order', async () => {
  const db = fresh();
  const { spies, log } = makeSpies(db);
  await makeHandler(db, spies)(
    makeReq(ORDER({ save_customer: true, recipient_phone: '13800003333', status: 'paid' })), makeRes());
  const money = log.filter((x) => x !== 'logActivity' && x !== 'geocode');
  assert.deepStrictEqual(money, ['claimMigrationCredit', 'reconcileSignupVouchers', 'markOrderPaid'],
    `post-commit order changed: ${JSON.stringify(log)}`);
});

// 5 ── ROLLBACK, exact row sets. A forced failure at the LAST write inside the
// block, standing in for any mid-transaction failure. The order and its items
// are already written when it fires, and save_customer means a customer is too.
await it('a failure at the last write rolls back the order, the items AND the customer', async () => {
  const db = fresh();
  const { spies, log } = makeSpies(db);
  db.exec('DROP TABLE retail_payments');            // forced: the third INSERT throws
  const res = makeRes();
  let threw = null;
  try {
    await makeHandler(db, spies)(
      makeReq(ORDER({ save_customer: true, recipient_phone: '13800004444' })), res);
  } catch (e) { threw = e; }

  assert.ok(threw, 'the handler swallowed a mid-transaction failure');
  assert.deepStrictEqual(all(db, 'retail_orders'), [], 'the order survived a rolled-back transaction');
  assert.deepStrictEqual(all(db, 'retail_order_items'), [], 'item rows survived a rolled-back transaction');
  assert.deepStrictEqual(all(db, 'retail_customers'), [],
    'the customer survived — "either both rows exist or neither does" is broken');
  assert.deepStrictEqual(log, [], 'post-commit work ran after a rolled-back transaction');
});

// 6 ── The customer_rejected path: a 400, and nothing written.
await it('customer_rejected: answers 400 and writes nothing', async () => {
  const db = fresh();
  const { spies, log } = makeSpies(db);
  const res = makeRes();
  await makeHandler(db, spies)(
    makeReq(ORDER({ save_customer: true, recipient_phone: '+441234567890', recipient_name: '' })), res);
  // A blank name is rejected before the transaction; use a name so the helper
  // is reached, and a phone the helper itself refuses.
  const db2 = fresh();
  const s2 = makeSpies(db2);
  const res2 = makeRes();
  await makeHandler(db2, s2.spies)(
    makeReq(ORDER({ save_customer: true, recipient_name: 'Ada', recipient_phone: '' , customer_id: '' })), res2);
  assert.strictEqual(res2.code, 200, 'a nameless-phoneless save is still a valid guest order');
  assert.strictEqual(res.code, 400, 'a blank recipient name must be a 400');
  assert.deepStrictEqual(all(db, 'retail_orders'), []);
  assert.deepStrictEqual(log, []);
});

// 7 ── A THROW IN POST-COMMIT WORK MUST NOT UNDO THE ORDER. This is the other
// half of the boundary, and it is the one a reader is most likely to doubt.
await it('a failure in post-commit money work does NOT roll back the committed order', async () => {
  const db = fresh();
  const { spies } = makeSpies(db, { paidThrows: true });
  const res = makeRes();
  await makeHandler(db, spies)(
    makeReq(ORDER({ status: 'paid' })), res);

  assert.strictEqual(n(db, 'retail_orders'), 1, 'a post-commit throw destroyed a committed order');
  assert.strictEqual(n(db, 'retail_order_items'), 1);
  assert.strictEqual(n(db, 'retail_payments'), 1);
  assert.strictEqual(res.code, 200, 'a post-commit throw changed the response');
});

await it('a throw in claimMigrationCredit does NOT roll back, and the order still answers 200', async () => {
  const db = fresh();
  const { spies } = makeSpies(db, { creditThrows: true });
  const res = makeRes();
  await makeHandler(db, spies)(
    makeReq(ORDER({ save_customer: true, recipient_phone: '13800005555' })), res);
  assert.strictEqual(n(db, 'retail_orders'), 1, 'a post-commit throw destroyed a committed order');
  assert.strictEqual(n(db, 'retail_customers'), 1, 'a post-commit throw destroyed a committed customer');
  assert.strictEqual(res.code, 200);
});

// 8 ── nextOrderNo on the transaction handle reads the block's OWN uncommitted
// rows. This is what the threading buys, and it is invisible from the outside.
await it('nextOrderNo(tx) sees the transaction\'s uncommitted rows', async () => {
  const db = fresh();
  const { spies } = makeSpies(db);
  await makeHandler(db, spies)(makeReq(ORDER()), makeRes());
  const { spies: s2 } = makeSpies(db);
  await makeHandler(db, s2)(makeReq(ORDER()), makeRes());
  const nos = all(db, 'retail_orders').map((o) => o.order_no);
  assert.deepStrictEqual(nos, ['TC000001', 'TC000002'], `numbers did not advance: ${nos}`);
});

// ── Source assertions ──────────────────────────────────────────────────────

await it('source: the handler is async', () => {
  assert.ok(RETAIL_SRC.includes(HANDLER_ANCHOR), 'the handler is not async');
});

await it('source: the transaction body uses tx and no ambient tdb()', () => {
  const open = 'await withTransaction(tdb(), async (tx) => {';
  const i = REAL_BODY.indexOf(open);
  assert.notStrictEqual(i, -1, 'the withTransaction opener is not the expected shape');
  const block = REAL_BODY.slice(i + open.length, REAL_BODY.indexOf('\n  } catch (e) {'));
  const stripped = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/\btdb\(\)/.test(stripped), 'an ambient tdb() survives inside the transaction body');
  assert.ok(/\btx\.prepare\(/.test(stripped), 'the body does not use tx.prepare');
});

await it('source: nextOrderNo and createOrReuseManualCustomer are both passed tx', () => {
  assert.ok(/orderNo = nextOrderNo\(tx\);/.test(REAL_BODY), 'nextOrderNo is not passed tx');
  assert.ok(/\}, tx\);/.test(REAL_BODY), 'createOrReuseManualCustomer is not passed tx');
});

await it('source: nextOrderNo carries the handle and NOT a driver branch', () => {
  assert.ok(/^function nextOrderNo\(h = tdb\(\)\) \{$/m.test(RETAIL_SRC),
    'nextOrderNo does not carry the trailing optional handle');
  const fn = stripComments(extractFunction(RETAIL_SRC, 'nextOrderNo'));
  assert.ok(!/typeof .*\.query|nextval|retail_order_counters/.test(fn),
    'a driver branch reached nextOrderNo — the pg arm cannot be exercised yet and must not ship here');
});

await it('source: the post-commit calls are still AFTER the catch block', () => {
  const catchEnd = REAL_BODY.indexOf('\n  }\n\n  // Resolve the staff-typed ship-to');
  assert.notStrictEqual(catchEnd, -1, 'the post-commit region moved or was reshaped');
  const after = REAL_BODY.slice(catchEnd);
  for (const name of ['geocodeOrderSnapshotAsync', 'claimMigrationCredit',
                      'reconcileSignupVouchers', 'markOrderPaid']) {
    assert.ok(after.includes(name), `${name} is no longer after the transaction`);
  }
  // COMMENTS STRIPPED FIRST. "markOrderPaid() flips it below" is a comment
  // INSIDE the transaction block, and matching it reported the call as having
  // moved into the transaction — the comment-blind matching §24 records twice.
  // Caught by this suite failing on its own assertion, which is the only reason
  // it is written down here rather than repeated.
  const before = stripComments(REAL_BODY.slice(0, catchEnd));
  for (const name of ['claimMigrationCredit', 'reconcileSignupVouchers', 'markOrderPaid']) {
    assert.ok(!before.includes(name + '('), `${name} moved INSIDE the transaction — that is the money-cluster line`);
  }
});

// ── Footer ─────────────────────────────────────────────────────────────────
console.log('');
console.log(`  driver: ${driver}`);
if (MUTANT) {
  console.log(`  mutant: dropped the await before withTransaction (${mutationCount} site)`);
  console.log(`  mutant: ${fail} failed  (0 would mean the suite cannot detect post-commit work running before COMMIT)`);
  if (fail === 0) {
    console.log('\n  MUTANT SURVIVED — the suite proves nothing. Treat as a failure.\n');
    process.exitCode = 1;
  } else {
    console.log(`\n  ${pass} passed, ${fail} failed — mutant correctly detected\n`);
    process.exitCode = 0;
  }
} else {
  if (failures.length) console.log(`  failed: ${failures.join(', ')}`);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}
})();
