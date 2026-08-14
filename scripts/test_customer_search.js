#!/usr/bin/env node
/**
 * Customers-roster search: can an operator find a customer by their phone?
 *
 *   node scripts/test_customer_search.js
 *
 * No network, no keys, no server. `routes/retail.js` cannot be required (it
 * opens a real database at load), so the REAL `customerSearchWhere` and its two
 * helpers are sliced out of the file and executed — the technique
 * scripts/test_migration_credit_ledger.js uses. The SQL they build is then run
 * against an in-memory database carrying the REAL table definitions out of
 * database.js. A suite that rebuilt either half would be testing a different
 * program, and this defect lived entirely in the half that would have been
 * rebuilt.
 *
 * ── WHAT IT LOCKS DOWN ────────────────────────────────────────────────────
 * The reported symptom: a full, correct mobile number typed into the roster
 * search returned "No customers match this search" for a customer who was on
 * file. Three separate ways that happened, one test each below:
 *
 *   • the STORED number carries separators ('183 2711 7510');
 *   • the TYPED number carries them ('+86 183 2711 7510');
 *   • the number is only on the ORDER (retail_orders.recipient_phone), because
 *     the profile phone is blank and no saved address survives.
 *
 * And the guard that keeps the fix from being worse than the defect: a query
 * that is not phone-shaped ('Wang 8') must NOT be matched against phone digits,
 * or every customer with an 8 in their number buries the person being looked
 * for. Plus the regressions — name, openid, order number, order id — because
 * this predicate is also what the voucher autocomplete searches with.
 *
 * TO PROVE THE SUITE CAN FAIL:  CS_MUTANT=1 node scripts/test_customer_search.js
 * The mutant restores the pre-fix predicate (the raw LIKE clauses alone, with
 * the digit-normalised ones deleted) and the suite must go RED. Per decisions
 * §24 the mutation ASSERTS IT MODIFIED THE SOURCE before its red counts as
 * evidence.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { openTablesDb, driver } = require('./test-support/memory-db');

const MUTANT = process.env.CS_MUTANT === '1';
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const DB_SRC = read('database.js');
const RETAIL_SRC = read('routes/retail.js');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── The real predicate, lifted out ────────────────────────────────────────
// One slice from the arrow const through the end of customerSearchWhere: the
// three pieces are one unit and only meaningful together.
function sliceSearchSource(src) {
  const start = src.indexOf('const SEARCH_PHONE_DIGITS = (col) =>');
  assert.notStrictEqual(start, -1, 'SEARCH_PHONE_DIGITS not found in routes/retail.js');
  const fn = src.indexOf('function customerSearchWhere(q) {', start);
  assert.notStrictEqual(fn, -1, 'customerSearchWhere not found after SEARCH_PHONE_DIGITS');
  const end = src.indexOf('\n}', fn);
  assert.notStrictEqual(end, -1, 'unterminated customerSearchWhere');
  return src.slice(start, end + 2);
}

let SRC = sliceSearchSource(RETAIL_SRC);
if (MUTANT) {
  // Restore the defect: keep the raw LIKE clauses, delete every digit-normalised
  // one. That is exactly what the endpoint did before this fix.
  const anchor = '  const digits = searchPhoneDigits(term);';
  assert.ok(SRC.includes(anchor), 'mutation anchor not found — a red run would prove nothing');
  const cut = SRC.indexOf(anchor);
  const resume = SRC.indexOf("  return { sql: '(' + ors.join(' OR ') + ')', params };", cut);
  assert.notStrictEqual(resume, -1, 'could not locate the end of the digit block to excise');
  const mutated = SRC.slice(0, cut) + SRC.slice(resume);
  assert.notStrictEqual(mutated, SRC, 'the mutant source is identical to the real source');
  assert.ok(!mutated.includes('SEARCH_PHONE_DIGITS(\'phone\')'),
            'the mutant still contains a digit-normalised phone clause');
  SRC = mutated;
}

const sandbox = {};
vm.runInNewContext(SRC + '\nthis.customerSearchWhere = customerSearchWhere;'
                       + '\nthis.searchPhoneDigits = searchPhoneDigits;', sandbox);
const { customerSearchWhere, searchPhoneDigits } = sandbox;

// ── Fixture ───────────────────────────────────────────────────────────────
const TABLES = ['retail_customers', 'retail_orders', 'retail_customer_addresses'];
const db = openTablesDb(DB_SRC, TABLES);

const addCustomer = (id, openid, nickname, phone, blocked = 0) =>
  db.prepare('INSERT INTO retail_customers (id, openid, nickname, phone, is_blocked) VALUES (?, ?, ?, ?, ?)')
    .run(id, openid, nickname, phone, blocked);
const addOrder = (id, customerId, orderNo, recipientPhone) =>
  db.prepare('INSERT INTO retail_orders (id, order_no, customer_id, recipient_phone) VALUES (?, ?, ?, ?)')
    .run(id, orderNo, customerId, recipientPhone);
const addAddress = (customerId, phone) =>
  db.prepare(`INSERT INTO retail_customer_addresses (customer_id, recipient_name, phone, address)
              VALUES (?, 'Recipient', ?, 'Somewhere in Guangzhou')`).run(customerId, phone);

// 1 — the number as the fix expects it: bare digits, on the profile.
addCustomer(1, 'oAAAAAAAAAAAAAAAAAAAAAAAAAA1', 'Clean Record', '13800138000');
// 2 — THE REPORTED CASE: stored with the separators a human typed.
addCustomer(2, 'manual:spaced', 'Spaced Phone', '183 2711 7510');
// 3 — stored with a country code and hyphens.
addCustomer(3, 'manual:wrapped', 'Wrapped Phone', '+86 137-0013-8000');
// 4 — no profile phone; the number lives on a saved address, formatted.
addCustomer(4, 'oAAAAAAAAAAAAAAAAAAAAAAAAAA4', 'Address Only', null);
addAddress(4, '188 8888 8888');
// 5 — no profile phone, no address: the number is only on the order snapshot.
addCustomer(5, 'oAAAAAAAAAAAAAAAAAAAAAAAAAA5', 'Order Only', null);
addOrder(5001, 5, 'R26010100005', '15999998888');
// 6 — blocked, and holding a searched-for number. The roster's default segment
//     hides them; the predicate itself must still match, which is what lets the
//     endpoint count them and say so.
addCustomer(6, 'manual:blocked', 'Blocked Holder', '17612341234', 1);
// 7 — a name with a digit in it, and a phone containing that same digit. The
//     bait for the "match every query's digits against phones" mistake.
addCustomer(7, 'oAAAAAAAAAAAAAAAAAAAAAAAAAA7', 'Wang 8', '13100008888');
// 8 — a guest order: customer_id NULL, and a recipient phone nobody owns.
addOrder(5002, null, 'R26010100008', '13700000000');

// Run a search exactly as the endpoint does: the predicate AND'd into a WHERE
// against retail_customers. is_blocked is deliberately NOT applied — this asks
// what the predicate matches, and the segment filter is the endpoint's own
// question, tested separately by the two counts it returns.
function search(q) {
  const w = customerSearchWhere(q);
  if (!w) return null;
  return db.prepare(`SELECT id FROM retail_customers WHERE ${w.sql} ORDER BY id`)
           .all(...w.params).map(r => r.id);
}

console.log(`\ncustomer roster search — driver: ${driver}${MUTANT ? '  [MUTANT]' : ''}\n`);

console.log('the reported defect — a full, correct number that found nobody');
it('finds a number stored with spaces ("183 2711 7510") when typed bare', () => {
  assert.deepStrictEqual(search('18327117510'), [2]);
});
it('finds a bare stored number when typed with spaces and a country code', () => {
  assert.deepStrictEqual(search('+86 138 0013 8000'), [1]);
});
it('finds a number stored with BOTH a country code and hyphens', () => {
  assert.deepStrictEqual(search('13700138000'), [3]);
});
it('finds a customer whose number is only on a saved address', () => {
  assert.deepStrictEqual(search('18888888888'), [4]);
});
it('finds a customer whose number is only on an order snapshot', () => {
  assert.deepStrictEqual(search('15999998888'), [5]);
});
it('matches a blocked customer, so the endpoint can report one is hidden', () => {
  assert.deepStrictEqual(search('17612341234'), [6]);
});
it('finds by the last four digits, the way staff actually ask', () => {
  assert.deepStrictEqual(search('7510'), [2]);
});

console.log('\nthe guard — a search must not drown in phone digits');
it('a name with a digit is not matched against phone numbers', () => {
  // '8' appears in customers 4, 5, 7's numbers. Only the NAME may match.
  assert.deepStrictEqual(search('Wang 8'), [7]);
});
it('searchPhoneDigits refuses anything that is not phone-shaped', () => {
  assert.strictEqual(searchPhoneDigits('Wang 8'), '');
  assert.strictEqual(searchPhoneDigits('R26010100005'), '');
  assert.strictEqual(searchPhoneDigits('wxid_abc'), '');
});
it('searchPhoneDigits refuses a fragment too short to be a phone', () => {
  assert.strictEqual(searchPhoneDigits('183'), '');
  assert.strictEqual(searchPhoneDigits('1832'), '1832');
});
it('searchPhoneDigits unwraps every country-code shape', () => {
  assert.strictEqual(searchPhoneDigits('+86 138 0013 8000'), '13800138000');
  assert.strictEqual(searchPhoneDigits('8613800138000'), '13800138000');
  assert.strictEqual(searchPhoneDigits('08613800138000'), '13800138000');
  assert.strictEqual(searchPhoneDigits('008613800138000'), '13800138000');
});
it('a guest order cannot conjure a customer row', () => {
  assert.deepStrictEqual(search('13700000000'), []);
});
it('an empty search is no search at all', () => {
  assert.strictEqual(customerSearchWhere(''), null);
  assert.strictEqual(customerSearchWhere('   '), null);
  assert.strictEqual(customerSearchWhere(null), null);
});

console.log('\nno regressions — everything the search matched before');
it('still matches a nickname', () => {
  assert.deepStrictEqual(search('Clean Record'), [1]);
});
it('still matches an openid', () => {
  assert.deepStrictEqual(search('manual:blocked'), [6]);
});
it('still matches an order number', () => {
  assert.deepStrictEqual(search('R26010100005'), [5]);
});
it('still matches an order id typed as a number', () => {
  assert.deepStrictEqual(search('5001'), [5]);
});
it('still matches a raw substring of a stored phone', () => {
  assert.deepStrictEqual(search('138001380'), [1]);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (MUTANT) {
  if (fail === 0) {
    console.log('MUTANT RAN GREEN — the suite does not detect the defect it exists to catch.');
    process.exit(1);
  }
  console.log('MUTANT RED, as required.');
  process.exit(0);
}
process.exit(fail ? 1 : 0);
