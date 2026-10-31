#!/usr/bin/env node
/**
 * test_shop_clock_per_account.js — each account's reports end the day at its
 * own midnight, even when two accounts ask within the same minute.
 *
 *   node scripts/test_shop_clock_per_account.js
 *
 * WHAT IT GUARDS. shopSqlShift() turns the shop's time zone into the SQL shift
 * every "today", dashboard and finance figure is bucketed by (audit A-05). It
 * remembers the answer for a minute, PER ACCOUNT. test_business_day.js proves
 * the zone is read at all; nothing proved the memo is per account. Keying it
 * on one shared slot failed no suite, yet on a platform with merchants in
 * different zones it hands the first merchant's day boundary to every other
 * merchant for up to a minute.
 *
 * THE REAL FUNCTION IS LIFTED FROM THE SOURCE AND RUN (retailSource() finds it
 * in routes/retail.js or in lib/ once it moves under decisions §477), with the
 * real lib/business-date.js and two accounts on two scratch databases.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const Database = require('better-sqlite3');
const businessDate = require(path.join(__dirname, '..', 'lib', 'business-date'));
const { retailSource } = require('./test-support/retail-source');

const SRC = retailSource();
function extract(re, what) {
  const m = re.exec(SRC);
  assert.ok(m, `${what} not found`);
  return m[0];
}
const MEMO = extract(/^const _tzMemo = new Map\(\);.*$/m, 'the _tzMemo declaration');
const FN = (() => {
  const at = SRC.search(/^function shopSqlShift\(/m);
  assert.ok(at >= 0, 'function shopSqlShift not found');
  return SRC.slice(at, SRC.indexOf('\n}', at) + 2);
})();

function account(zone) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT)');
  db.prepare("INSERT INTO storefront_config VALUES ('shop.timezone', ?)").run(JSON.stringify(zone));
  return db;
}
const ROOTS = 1;
const DBS = { 1: account('Asia/Shanghai'), 2: account('Europe/London'), 3: account('America/New_York') };
const want = (tid) => businessDate.sqlDayShiftForShop(DBS[tid]);

// A fresh copy of the function (and its memo) per case, with the account and
// the clock under the test's control.
function clock() {
  const st = { tid: ROOTS, now: Date.parse('2040-01-04T02:00:00Z'), throws: false };
  const FakeDate = { now: () => st.now };
  const shopSqlShift = new Function('currentTenantId', 'ROOTS_TENANT_ID', 'tdb', 'businessDate', 'Date',
    `${MEMO}\n${FN}\nreturn shopSqlShift;`)(
    () => { if (st.throws) throw new Error('no tenant context'); return st.tid; },
    // tdb() is the request's account database, or the platform's own when no
    // account is in context, as lib/tenant-db.js does.
    ROOTS, () => (st.throws ? DBS[ROOTS] : DBS[st.tid]), businessDate, FakeDate);
  return { st, shopSqlShift };
}

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n0. the three zones really differ, or nothing below means anything');
it('Shanghai, London and New York give three different shifts', () => {
  assert.strictEqual(new Set([want(1), want(2), want(3)]).size, 3, `${want(1)} / ${want(2)} / ${want(3)}`);
});

console.log('\n1. two accounts in the same minute each get their own day');
it('Shanghai first, then London: London is not handed Shanghai\'s shift', () => {
  const { st, shopSqlShift } = clock();
  st.tid = 1; assert.strictEqual(shopSqlShift(), want(1));
  st.tid = 2; assert.strictEqual(shopSqlShift(), want(2), 'London got another account\'s day boundary');
});
it('London first, then Shanghai, then New York, all within the minute', () => {
  const { st, shopSqlShift } = clock();
  for (const tid of [2, 1, 3, 2, 1]) {
    st.tid = tid; st.now += 1000;
    assert.strictEqual(shopSqlShift(), want(tid), `account ${tid} got another account's shift`);
  }
});
it('no account in context answers for the platform account', () => {
  const { st, shopSqlShift } = clock();
  st.tid = 2; shopSqlShift();
  st.throws = true;
  assert.strictEqual(shopSqlShift(), want(ROOTS));
});

console.log('\n2. the memo lasts a minute, per account');
it('a zone change is not seen inside the minute, and is seen after it', () => {
  const { st, shopSqlShift } = clock();
  st.tid = 2; const before = shopSqlShift();
  DBS[2].prepare("UPDATE storefront_config SET value_json = ? WHERE key = 'shop.timezone'").run(JSON.stringify('Asia/Tokyo'));
  try {
    st.now += 30_000;
    assert.strictEqual(shopSqlShift(), before, 'the memo did not hold for the minute');
    st.now += 31_000;
    assert.strictEqual(shopSqlShift(), want(2), 'the memo held past the minute');
    assert.notStrictEqual(want(2), before, 'setup: Tokyo and London gave the same shift');
  } finally {
    DBS[2].prepare("UPDATE storefront_config SET value_json = ? WHERE key = 'shop.timezone'").run(JSON.stringify('Europe/London'));
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
