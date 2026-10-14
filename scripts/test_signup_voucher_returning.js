#!/usr/bin/env node
/**
 * test_signup_voucher_returning.js — the welcome coupon goes to new customers,
 * and never to a returning OUT1N customer.
 *
 *   node scripts/test_signup_voucher_returning.js
 *
 * WHAT IT GUARDS. reconcileSignupVouchers decides, from the customer's phone,
 * whether they are a new signup (grant the auto_grant_signup vouchers) or a
 * returning OUT1N customer (their phone is in retail_migration_credits: grant
 * nothing, and pull back an unused auto-granted one). It runs at every place a
 * phone arrives: login, OTP, web sign-in, a saved address, the admin screens.
 * Until this suite nothing exercised it: making every returning customer look
 * new failed no suite, though it hands the welcome coupon to every OUT1N
 * customer who comes back.
 *
 * THE REAL FUNCTIONS ARE LIFTED FROM THE SOURCE AND RUN, the way
 * test_migration_credit_ledger.js runs claimMigrationCredit, over the real
 * table definitions from database.js. retailSource() finds them wherever they
 * live (routes/retail.js, or lib/ once they move under decisions §477).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SRC = retailSource();

function extractFunction(code, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(code);
  assert.ok(m, `function ${name} not found`);
  const end = code.indexOf('\n}', m.index);
  assert.notStrictEqual(end, -1, `unterminated function ${name}`);
  return code.slice(m.index, end + 2);
}
const BODY = ['normalizeMigrationPhone', 'grantSignupVouchers', 'reconcileSignupVouchers']
  .map((n) => extractFunction(SRC, n)).join('\n');

const TABLES = ['retail_customers', 'retail_migration_credits', 'retail_vouchers', 'retail_customer_vouchers'];
function fresh() {
  const db = openTablesDb(DB_SRC, TABLES);
  if (typeof db.transaction !== 'function') {          // node:sqlite has none
    db.transaction = (fn) => (...a) => {
      db.exec('BEGIN');
      try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    };
  }
  const v = db.prepare(`INSERT INTO retail_vouchers (id, code, type, value, is_active, auto_grant_signup, expires_at)
                        VALUES (?, ?, 'fixed_amount', 10, ?, ?, ?)`);
  v.run(1, 'WELCOME', 1, 1, null);                       // the signup voucher
  v.run(2, 'OLDWELCOME', 0, 1, null);                    // inactive: never granted
  v.run(3, 'GONE', 1, 1, '2000-01-01 00:00:00');         // expired: never granted
  v.run(4, 'GIFT', 1, 0, null);                          // not a signup voucher
  const c = db.prepare('INSERT INTO retail_customers (id, openid, nickname, phone) VALUES (?, ?, ?, ?)');
  c.run(1, 'o1', 'New', '13900000001');
  c.run(2, 'o2', 'Returning', '13900000002');
  c.run(3, 'o3', 'No phone yet', null);
  db.prepare("INSERT INTO retail_migration_credits (phone, balance, points) VALUES ('13900000002', 0, 0)").run();
  db.prepare("INSERT INTO retail_migration_credits (phone, balance, points) VALUES ('13900000009', 0, 0)").run();
  return db;
}
function fns(db) {
  return new Function('tdb', `${BODY}\nreturn { grantSignupVouchers, reconcileSignupVouchers };`)(() => db);
}
const held = (db, cid) => db.prepare('SELECT voucher_id FROM retail_customer_vouchers WHERE customer_id = ? ORDER BY voucher_id')
  .all(cid).map((r) => r.voucher_id);

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n1. a new customer gets the welcome coupon, once');
it('a brand-new phone is granted the active, unexpired signup voucher and nothing else', () => {
  const db = fresh();
  assert.strictEqual(fns(db).reconcileSignupVouchers(1), 1, 'should report one voucher granted');
  assert.deepStrictEqual(held(db, 1), [1]);
});
it('asking again grants nothing more', () => {
  const db = fresh(); const f = fns(db);
  f.reconcileSignupVouchers(1);
  assert.strictEqual(f.reconcileSignupVouchers(1), 0, 'a second call reported a grant');
  assert.deepStrictEqual(held(db, 1), [1]);
});
it('no phone yet: nothing is decided and nothing granted', () => {
  const db = fresh();
  assert.strictEqual(fns(db).reconcileSignupVouchers(3), 0);
  assert.deepStrictEqual(held(db, 3), []);
});

console.log('\n2. a returning OUT1N customer never gets it');
it('a phone on the OUT1N roster (even with nothing to claim) is granted nothing', () => {
  const db = fresh();
  assert.strictEqual(fns(db).reconcileSignupVouchers(2), 0, 'a returning customer was reported as granted');
  assert.deepStrictEqual(held(db, 2), [], 'a returning customer holds the welcome coupon');
});
it('the roster match ignores +86, spaces and dashes', () => {
  const db = fresh();
  db.prepare("UPDATE retail_customers SET phone = '+86 139-0000-0002' WHERE id = 2").run();
  assert.strictEqual(fns(db).reconcileSignupVouchers(2), 0);
  assert.deepStrictEqual(held(db, 2), []);
});
it('an unused welcome coupon granted before the phone was known is pulled back', () => {
  const db = fresh(); const f = fns(db);
  f.grantSignupVouchers(2);                               // e.g. granted at first login
  assert.deepStrictEqual(held(db, 2), [1], 'setup: the grant did not happen');
  f.reconcileSignupVouchers(2);
  assert.deepStrictEqual(held(db, 2), [], 'the welcome coupon stayed with a returning customer');
});
it('a welcome coupon the returning customer already used stays on their record', () => {
  const db = fresh();
  db.prepare(`INSERT INTO retail_customer_vouchers (customer_id, voucher_id, granted_by, granted_note, used_at)
              VALUES (2, 1, NULL, 'Auto-granted on signup', '2026-01-01 00:00:00')`).run();
  fns(db).reconcileSignupVouchers(2);
  assert.deepStrictEqual(held(db, 2), [1]);
});
it('the welcome voucher handed over on purpose by an operator stays, by person or by note', () => {
  const db = fresh();
  db.prepare("INSERT INTO retail_customers (id, openid, nickname, phone) VALUES (4, 'o4', 'Returning too', '13900000009')").run();
  db.prepare(`INSERT INTO retail_customer_vouchers (customer_id, voucher_id, granted_by, granted_note)
              VALUES (2, 1, NULL, 'Sorry about the late delivery')`).run();
  db.prepare(`INSERT INTO retail_customer_vouchers (customer_id, voucher_id, granted_by, granted_note)
              VALUES (4, 1, 7, 'Auto-granted on signup')`).run();
  const f = fns(db);
  f.reconcileSignupVouchers(2); f.reconcileSignupVouchers(4);
  assert.deepStrictEqual(held(db, 2), [1], 'an operator\'s note-marked gift was pulled back');
  assert.deepStrictEqual(held(db, 4), [1], 'a gift recorded with its granter was pulled back');
});

console.log('\n3. the phone hint from a saved address');
it('a customer with no phone but a new address phone is granted', () => {
  const db = fresh();
  assert.strictEqual(fns(db).reconcileSignupVouchers(3, '13900000003'), 1);
  assert.deepStrictEqual(held(db, 3), [1]);
});
it('a customer with no phone but a roster address phone is granted nothing', () => {
  const db = fresh();
  assert.strictEqual(fns(db).reconcileSignupVouchers(3, '13900000009'), 0);
  assert.deepStrictEqual(held(db, 3), []);
});
it('the hint is never written to the account (it keys the OUT1N wallet claim)', () => {
  const db = fresh();
  fns(db).reconcileSignupVouchers(3, '13900000003');
  assert.strictEqual(db.prepare('SELECT phone FROM retail_customers WHERE id = 3').get().phone, null);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
