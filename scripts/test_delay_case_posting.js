#!/usr/bin/env node
/**
 * A carrier's compensation reaches the books when it LANDS, and not before.
 *
 *   node scripts/test_delay_case_posting.js
 *
 * WHY THIS EXISTS. §87's rule is that a staff claim is not an expense because
 * somebody asked for it; §98 stage four restates that for money in. A claim
 * that is merely FILED must post nothing, because a carrier that later rejects
 * it — or pays ¥250 against the ¥312.40 asked — would otherwise have left
 * revenue in the books that never arrived, with nothing on any screen to say
 * so. If `postDelayCase` ever posts on 'filed', that is back.
 *
 * WHAT IT LOCKS DOWN:
 *   1. Only 'paid' posts. Filed, rejected, withdrawn and not-claiming post
 *      nothing, and each of them REMOVES a row that a previous 'paid' left.
 *   2. It is idempotent — the delete-then-reinsert shape `postClaim` uses, so
 *      calling it twice cannot put the same money in twice.
 *   3. The row is dated the day the carrier SETTLED, not the day the claim was
 *      filed: a claim filed in August and paid in September is September's.
 *   4. It carries NO category, because the income category list ships empty by
 *      decision (§36) and this file may not seed one.
 *
 * No network, no keys, no server — an in-memory SQLite, the shipped schema, and
 * lib/delay-case-posting.js.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const dc = require('../lib/delay-case');
const { postDelayCase, postedRow, caseDate } = require('../lib/delay-case-posting');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// ── The shipped schema, lifted rather than copied ──────────────────────────
const DB_SRC = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
const CASES = DB_SRC.match(
  /db\.exec\(`(\s*CREATE TABLE IF NOT EXISTS retail_delay_cases[\s\S]*?)`\);/
);
if (!CASES) {
  console.error('could not find the retail_delay_cases schema in database.js');
  process.exit(1);
}
// income_entries lives in schema.sql, and the delay_case_id column is an
// addColumn in database.js — so the fixture builds the table from the one and
// asserts the other is really requested, rather than inventing either.
const SQL_SRC = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const INCOME = SQL_SRC.match(/CREATE TABLE IF NOT EXISTS income_entries \([\s\S]*?\);/);
if (!INCOME) { console.error('could not find income_entries in schema.sql'); process.exit(1); }
assert.ok(
  /addColumn\('income_entries',\s*'delay_case_id'/.test(DB_SRC),
  'database.js must still add income_entries.delay_case_id — the whole posting keys on it'
);

function fresh() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_orders    (id INTEGER PRIMARY KEY, order_no TEXT);
    CREATE TABLE retail_shipments (id INTEGER PRIMARY KEY);
    CREATE TABLE users (id INTEGER PRIMARY KEY);
  `);
  db.exec(CASES[1]);
  db.exec(INCOME[0]);
  db.exec('ALTER TABLE income_entries ADD COLUMN delay_case_id INTEGER');
  db.prepare("INSERT INTO retail_orders (id, order_no) VALUES (100,'R2026082600088')").run();
  db.prepare('INSERT INTO retail_shipments (id) VALUES (55)').run();
  // `income_entries.created_by` really does reference `users`, so the person
  // recording the settlement has to exist. Worth keeping rather than switching
  // the pragma off: it proves the posted row's author is a real account.
  db.prepare('INSERT INTO users (id) VALUES (7)').run();
  return db;
}

const ACTOR = { id: 7, label: 'mei' };
const step = (db, s, payload) =>
  dc.applyStep(db, { orderId: 100, shipmentId: 55, step: s, payload: payload || {}, actor: ACTOR });
const order = { order_no: 'R2026082600088' };
const rows = db => db.prepare('SELECT * FROM income_entries').all();

// ── 1. Filing posts nothing. The rule. ─────────────────────────────────────
it('a filed claim puts NOTHING in the books', () => {
  const db = fresh();
  const c = step(db, 'claim_filed', { carrier: 'jd', ref: 'JD-TS-4471', claimed: '312.40' });
  assert.strictEqual(postDelayCase(db, c, order), null);
  assert.strictEqual(rows(db).length, 0);
});

it('not claiming puts nothing in the books either', () => {
  const db = fresh();
  const c = step(db, 'no_claim', { note: 'under ¥50' });
  postDelayCase(db, c, order);
  assert.strictEqual(rows(db).length, 0);
});

// ── 2. Paid posts exactly one row ──────────────────────────────────────────
it('a settled payment posts one row, for the amount RECEIVED', () => {
  const db = fresh();
  step(db, 'claim_filed', { carrier: 'jd', ref: 'JD-TS-4471', claimed: '312.40' });
  const c = step(db, 'settled', { outcome: 'paid', received: '250' });
  const id = postDelayCase(db, c, order);
  const all = rows(db);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].id, id);
  // 250, not the 312.40 asked for. The gap is the case's to show, not the books'.
  assert.strictEqual(all[0].amount, 250);
  assert.strictEqual(all[0].delay_case_id, c.id);
});

it('the row names the carrier, the order and the claim, so it can be traced', () => {
  const db = fresh();
  step(db, 'claim_filed', { carrier: 'jd', ref: 'JD-TS-4471' });
  const c = step(db, 'settled', { outcome: 'paid', received: '250' });
  postDelayCase(db, c, order);
  const d = rows(db)[0].description;
  assert.ok(/JD/i.test(d), 'carrier: ' + d);
  assert.ok(d.includes('R2026082600088'), 'order: ' + d);
  assert.ok(d.includes('JD-TS-4471'), 'claim ref: ' + d);
});

it('the row carries NO category — the income list ships empty by decision', () => {
  const db = fresh();
  step(db, 'claim_filed', {});
  const c = step(db, 'settled', { outcome: 'paid', received: '10' });
  postDelayCase(db, c, order);
  assert.strictEqual(rows(db)[0].category, null);
});

it('the row is dated the day the carrier SETTLED, not the day it was filed', () => {
  const db = fresh();
  step(db, 'claim_filed', {});
  // Backdate the filing so the two stamps genuinely differ.
  db.prepare("UPDATE retail_delay_cases SET dispute_filed_at = '2026-08-01 09:00:00'").run();
  const c = step(db, 'settled', { outcome: 'paid', received: '10' });
  postDelayCase(db, c, order);
  assert.strictEqual(rows(db)[0].date, caseDate(c));
  assert.notStrictEqual(rows(db)[0].date, '2026-08-01');
});

it('who recorded the settlement is who put it in the books (§92)', () => {
  const db = fresh();
  const c = step(db, 'settled', { outcome: 'paid', received: '10' });
  postDelayCase(db, c, order);
  assert.strictEqual(c.settled_by, 'mei');
  assert.strictEqual(rows(db)[0].created_by, 7);
});

// ── 3. Idempotence, and the remove path ────────────────────────────────────
it('posting twice cannot put the same money in twice', () => {
  const db = fresh();
  const c = step(db, 'settled', { outcome: 'paid', received: '250' });
  postDelayCase(db, c, order);
  postDelayCase(db, c, order);
  postDelayCase(db, c, order);
  assert.strictEqual(rows(db).length, 1);
  assert.strictEqual(rows(db)[0].amount, 250);
});

it('a rejection AFTER a payment takes the row back out', () => {
  const db = fresh();
  let c = step(db, 'settled', { outcome: 'paid', received: '250' });
  postDelayCase(db, c, order);
  assert.strictEqual(rows(db).length, 1);
  c = step(db, 'settled', { outcome: 'rejected', note: 'clawed back' });
  postDelayCase(db, c, order);
  assert.strictEqual(rows(db).length, 0, 'the row is removed, not offset by a negative one');
});

it('re-filing a paid claim clears the money — the case says nothing is settled', () => {
  const db = fresh();
  let c = step(db, 'settled', { outcome: 'paid', received: '250' });
  postDelayCase(db, c, order);
  // claim_filed resets dispute_received, which is exactly why the route posts
  // after EVERY step and not only after a settlement.
  c = step(db, 'claim_filed', { ref: 'JD-2' });
  assert.strictEqual(c.dispute_received, null);
  postDelayCase(db, c, order);
  assert.strictEqual(rows(db).length, 0);
});

it('a corrected amount replaces the row rather than adding to it', () => {
  const db = fresh();
  let c = step(db, 'settled', { outcome: 'paid', received: '250' });
  postDelayCase(db, c, order);
  c = step(db, 'settled', { outcome: 'paid', received: '312.40' });
  postDelayCase(db, c, order);
  assert.strictEqual(rows(db).length, 1);
  assert.strictEqual(rows(db)[0].amount, 312.4);
});

it('a zero or missing payment posts nothing, rather than a ¥0 row', () => {
  const db = fresh();
  const c = dc.readCase(db, 55) || dc.ensureCase(db, 100, 55, ACTOR);
  db.prepare("UPDATE retail_delay_cases SET dispute_state='paid', dispute_received=0, dispute_settled_at=CURRENT_TIMESTAMP WHERE id=?").run(c.id);
  postDelayCase(db, dc.readCase(db, 55), order);
  assert.strictEqual(rows(db).length, 0);
});

it('postedRow finds the row standing for a case, and nothing once it is gone', () => {
  const db = fresh();
  let c = step(db, 'settled', { outcome: 'paid', received: '99' });
  postDelayCase(db, c, order);
  assert.strictEqual(postedRow(db, c.id).amount, 99);
  c = step(db, 'settled', { outcome: 'withdrawn' });
  postDelayCase(db, c, order);
  assert.strictEqual(postedRow(db, c.id), null);
});

// ── 4. The two cases do not collide ────────────────────────────────────────
it('two cases post two rows, each keyed to its own', () => {
  const db = fresh();
  db.prepare('INSERT INTO retail_shipments (id) VALUES (56)').run();
  const a = dc.applyStep(db, { orderId: 100, shipmentId: 55, step: 'settled',
    payload: { outcome: 'paid', received: '10' }, actor: ACTOR });
  const b = dc.applyStep(db, { orderId: 100, shipmentId: 56, step: 'settled',
    payload: { outcome: 'paid', received: '20' }, actor: ACTOR });
  postDelayCase(db, a, order);
  postDelayCase(db, b, order);
  assert.strictEqual(rows(db).length, 2);
  // Removing one must not touch the other.
  const a2 = dc.applyStep(db, { orderId: 100, shipmentId: 55, step: 'settled',
    payload: { outcome: 'rejected' }, actor: ACTOR });
  postDelayCase(db, a2, order);
  const left = rows(db);
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].delay_case_id, b.id);
});

console.log('\n  driver: better-sqlite3\n');
if (fails.length) {
  console.log(`  ${pass} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log(`  ${pass} passed, 0 failed`);
