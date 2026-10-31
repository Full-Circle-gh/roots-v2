#!/usr/bin/env node
/**
 * An existing customer is refused a referral code, not voided later.
 *
 *   node scripts/test_affiliate_new_customer.js
 *
 * WHY THIS EXISTS. The bounty pays on the invitee's FIRST paid order, so a
 * customer who has already paid for one can never convert — creditReferralReward
 * finds the earlier order and voids the row as `not_first_order`. But
 * POST /affiliate/apply accepted them anyway, so the refusal arrived after the
 * fact: it consumed the customer's one-shot `referred_by_customer_id`, told the
 * referrer they had an invite that would never pay, and left the admin ledger
 * showing the row as "Waiting" until the void fired.
 *
 * WHAT THIS ACTUALLY LOCKS DOWN, and it is the only thing worth locking: THE
 * TWO GUARDS AGREE. The apply guard and the payout void must answer the same
 * question the same way, or the guard just moves the disappointment. So the two
 * predicates are read OUT OF THE SHIPPED FILE and run against one fixture — a
 * test carrying its own copy of the SQL would go green while routes/retail.js
 * drifted underneath it.
 *
 * No network, no keys, no server: an in-memory SQLite holding the two columns
 * the predicates touch.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'retail.js'), 'utf8');

/* ── The two predicates, lifted from the shipped file ──────────────────────
   Anchored on the surrounding code rather than on the SQL alone, so a rename
   or a second copy elsewhere cannot satisfy the match by accident. */
function lift(re, what) {
  const m = SRC.match(re);
  assert.ok(m, 'could not find ' + what + ' in routes/retail.js — the anchor has drifted');
  return m[1].replace(/\s+/g, ' ').trim();
}

// The guard added to POST /affiliate/apply.
const APPLY_SQL = lift(
  /const priorPaidOrder = tdb\(\)\.prepare\(\s*'([^']+)'/,
  'the apply guard'
);
// The backstop inside creditReferralReward that voids as not_first_order.
const VOID_SQL = lift(
  /const earlier = tdb\(\)\.prepare\(\s*"([^"]+)"/,
  'the not_first_order void'
);
// The field the invite screen hides its apply box on.
const FIELD_SQL = lift(
  /const isNewCustomer = !tdb\(\)\.prepare\(\s*'([^']+)'/,
  'the is_new_customer read'
);

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_orders (
             id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, paid_at TEXT)`);
  return db;
}

// applyRefuses / voidFires, each running the REAL statement.
const applyRefuses = (db, cid) => !!db.prepare(APPLY_SQL).get(cid);
const isNew = (db, cid) => !db.prepare(FIELD_SQL).get(cid);
// The void's statement takes (customer_id, orderId) — the order being paid now.
const voidFires = (db, cid, orderId) => !!db.prepare(VOID_SQL).get(cid, orderId);

console.log('\n1 · the two predicates are the same test');

it('the apply guard and the is_new_customer read use one statement', () => {
  assert.strictEqual(APPLY_SQL, FIELD_SQL,
    'the screen and the server must not decide "new customer" two different ways');
});

it('both are the paid_at IS NOT NULL test the void uses', () => {
  for (const [name, sql] of [['apply guard', APPLY_SQL], ['void', VOID_SQL]]) {
    assert.ok(/paid_at IS NOT NULL/.test(sql), name + ' must test paid_at IS NOT NULL');
    assert.ok(/FROM retail_orders/.test(sql), name + ' must read retail_orders');
  }
  // The void's extra `id < ?` is the one difference and is deliberate: it asks
  // about orders BEFORE the one being paid right now, which is a question the
  // apply guard is not being asked.
  assert.ok(/id < \?/.test(VOID_SQL), 'the void still scopes to earlier orders');
  assert.ok(!/id < \?/.test(APPLY_SQL), 'the apply guard has no order to be earlier than');
});

console.log('\n2 · they agree over the shapes that occur');

it('no orders at all — admitted', () => {
  const db = freshDb();
  assert.strictEqual(applyRefuses(db, 1), false);
  assert.strictEqual(isNew(db, 1), true);
});

it('an unpaid order only — admitted', () => {
  const db = freshDb();
  db.prepare('INSERT INTO retail_orders VALUES (1, 1, ?, NULL)').run('pending_payment');
  assert.strictEqual(applyRefuses(db, 1), false, 'an unpaid order is not a paid one');
  assert.strictEqual(isNew(db, 1), true);
});

it("status='paid' with a NULL paid_at — admitted, and BOTH guards ignore it alike", () => {
  // The shape that would break the agreement if either guard read `status`
  // instead. Neither does, so the two stay in step on it.
  const db = freshDb();
  db.prepare('INSERT INTO retail_orders VALUES (1, 1, ?, NULL)').run('paid');
  assert.strictEqual(applyRefuses(db, 1), false);
  assert.strictEqual(voidFires(db, 1, 2), false);
});

it('a prior paid order — refused', () => {
  const db = freshDb();
  db.prepare('INSERT INTO retail_orders VALUES (1, 1, ?, ?)').run('paid', '2026-08-01 10:00:00');
  assert.strictEqual(applyRefuses(db, 1), true);
  assert.strictEqual(isNew(db, 1), false, 'the screen hides the apply box for them');
});

it("another customer's paid order is not this one's", () => {
  const db = freshDb();
  db.prepare('INSERT INTO retail_orders VALUES (1, 2, ?, ?)').run('paid', '2026-08-01 10:00:00');
  assert.strictEqual(applyRefuses(db, 1), false);
});

console.log('\n3 · the agreement itself, in both directions');

it("an admitted customer's first paid order does NOT trip the void", () => {
  // The whole point: everyone the guard lets through converts.
  const db = freshDb();
  assert.strictEqual(applyRefuses(db, 1), false);         // admitted, no orders
  db.prepare('INSERT INTO retail_orders VALUES (5, 1, ?, ?)').run('paid', '2026-09-01 10:00:00');
  assert.strictEqual(voidFires(db, 1, 5), false, 'their first paid order must pay the bounty');
});

it('a refused customer WOULD have been voided as not_first_order', () => {
  // And the other direction: everyone the guard turns away is someone the
  // payout would have refused anyway — the refusal is earlier, not stricter.
  const db = freshDb();
  db.prepare('INSERT INTO retail_orders VALUES (1, 1, ?, ?)').run('paid', '2026-08-01 10:00:00');
  assert.strictEqual(applyRefuses(db, 1), true);
  db.prepare('INSERT INTO retail_orders VALUES (5, 1, ?, ?)').run('paid', '2026-09-01 10:00:00');
  assert.strictEqual(voidFires(db, 1, 5), true, 'the void is what the guard now pre-empts');
});

console.log('\n4 · the route and the screen say the same thing');

it('the apply route refuses with existing_customer, 409', () => {
  const m = SRC.match(/if \(priorPaidOrder\) \{\s*return res\.status\((\d+)\)\.json\(\{ success: false, error: '([a-z_]+)' \}\);/);
  assert.ok(m, 'the refusal branch has drifted');
  assert.strictEqual(m[1], '409');
  assert.strictEqual(m[2], 'existing_customer');
});

it('the route sends is_new_customer as 1/0, not a raw row', () => {
  assert.ok(/is_new_customer:\s*isNewCustomer \? 1 : 0/.test(SRC),
    'is_new_customer must be a flag the client can compare against 0');
});

it('the mini app hides the box on !== 0, so an older server still shows it', () => {
  const APP = fs.readFileSync(
    path.join(__dirname, '..', 'miniapp', 'pages', 'affiliate', 'affiliate.js'), 'utf8');
  assert.ok(/canApply:[^\n]*data\.is_new_customer !== 0/.test(APP),
    'a truthy test would hide the box against a server that does not send the field yet');
  assert.ok(/existing_customer:\s*c\.errExisting/.test(APP),
    'the refusal must map to a localized message, or it is swallowed as generic');
  // Both halves, or one language gets an English sentence.
  assert.ok(/errExisting:\s*'Invite codes are for new customers only\.'/.test(APP), 'EN half');
  assert.ok(/errExisting:\s*'邀请码仅限新用户使用。'/.test(APP), 'CN half');
});

if (fails.length) {
  console.log('\n' + fails.length + ' failure(s).');
  process.exit(1);
}
console.log('\nok — ' + pass + ' cases; both predicates read out of routes/retail.js itself.');
