#!/usr/bin/env node
/**
 * A late-parcel case does not close while the carrier still owes an answer.
 *
 *   node scripts/test_delay_case.js
 *
 * WHY THIS EXISTS. §98's whole point is one refusal. The alert this replaces
 * had a single button meaning "I phoned the customer", and pressing it dropped
 * the orders-list badge AND the dashboard's "Delivery needs a call" card — so a
 * claim with the carrier, which is the half that runs for weeks, went unwatched
 * from the moment somebody made a phone call. If `blockers()` ever stops
 * returning `dispute_open` for a filed claim, that behaviour is silently back
 * and nothing on any screen would say so.
 *
 * WHAT IT LOCKS DOWN, in order of what would actually hurt:
 *   1. A filed claim blocks the close. The feature.
 *   2. `none` is not a finished state — never deciding is not the same as
 *      deciding not to claim, and a case nobody touched must stay open.
 *   3. Choosing NOT to claim finishes the track and needs a typed reason, so a
 *      ¥40 spoil is closeable and cannot later read as "nobody got round to it".
 *   4. A 'paid' outcome cannot be recorded without the amount, because the
 *      figure is the only thing that answers whether the carrier covered us.
 *
 * THE SCHEMA IS READ OUT OF THE SHIPPED FILE, not copied here: a test carrying
 * its own CREATE TABLE goes green while database.js drifts underneath it. Same
 * reason scripts/test_affiliate_new_customer.js lifts its predicates.
 *
 * No network, no keys, no server — an in-memory SQLite and lib/delay-case.js.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const dc = require('../lib/delay-case');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// ── The shipped schema, lifted ─────────────────────────────────────────────
const DB_SRC = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
const m = DB_SRC.match(
  /db\.exec\(`(\s*CREATE TABLE IF NOT EXISTS retail_delay_cases[\s\S]*?)`\);/
);
if (!m) {
  console.error('could not find the retail_delay_cases schema in database.js — ' +
                'if it moved or was renamed, fix this test rather than deleting it');
  process.exit(1);
}

function fresh() {
  const db = new Database(':memory:');
  // STUB PARENTS, NOT COPIES OF THEM. better-sqlite3 enforces foreign keys, so
  // the order and the parcel have to exist for a case to reference them — which
  // is worth having: it proves the two keys in the shipped schema actually
  // resolve, and a column renamed out from under them fails here rather than in
  // production. Only the id is modelled; nothing in lib/delay-case.js reads any
  // other column of either parent.
  db.exec(`
    CREATE TABLE retail_orders    (id INTEGER PRIMARY KEY);
    CREATE TABLE retail_shipments (id INTEGER PRIMARY KEY);
  `);
  db.exec(m[1]);
  db.prepare('INSERT INTO retail_orders (id) VALUES (100)').run();
  db.prepare('INSERT INTO retail_shipments (id) VALUES (55)').run();
  return db;
}

const ACTOR = { id: 7, label: 'mei' };
const step = (db, step_, payload) =>
  dc.applyStep(db, { orderId: 100, shipmentId: 55, step: step_, payload: payload || {}, actor: ACTOR });

// ── 1. A case nobody has touched blocks on everything ──────────────────────
it('a fresh case is blocked on all three tracks', () => {
  const db = fresh();
  const c = dc.ensureCase(db, 100, 55, ACTOR);
  assert.deepStrictEqual(dc.blockers(c).sort(),
    ['customer_not_made_whole', 'customer_not_told', 'dispute_open']);
  assert.strictEqual(dc.canClose(c), false);
});

it('opening a case is idempotent — one row per parcel', () => {
  const db = fresh();
  dc.ensureCase(db, 100, 55, ACTOR);
  dc.ensureCase(db, 100, 55, ACTOR);
  const n = db.prepare('SELECT COUNT(*) AS n FROM retail_delay_cases').get().n;
  assert.strictEqual(n, 1);
});

// ── 2. The step that used to mean everything now means one thing ───────────
it('telling the customer does NOT make the case closeable', () => {
  const db = fresh();
  const c = step(db, 'customer_told');
  assert.ok(c.customer_told_at, 'the step recorded');
  assert.strictEqual(c.customer_told_by, 'mei');
  // The regression this whole section exists to prevent.
  assert.strictEqual(dc.canClose(c), false);
  assert.ok(dc.blockers(c).includes('dispute_open'));
});

// ── 3. `none` is not a finished state ──────────────────────────────────────
it('a case with the customer told and made whole is STILL open on the dispute', () => {
  const db = fresh();
  step(db, 'customer_told');
  const c = step(db, 'remedy', { kind: 'replacement' });
  assert.deepStrictEqual(dc.blockers(c), ['dispute_open']);
});

// ── 4. Filing the claim is what starts the long wait ───────────────────────
it('a filed claim holds the case open, and records what was asked for', () => {
  const db = fresh();
  step(db, 'customer_told');
  step(db, 'remedy', { kind: 'replacement' });
  const c = step(db, 'claim_filed', { carrier: 'jd', ref: 'JD-TS-4471', claimed: '312.40' });
  assert.strictEqual(c.dispute_state, 'filed');
  assert.strictEqual(c.dispute_ref, 'JD-TS-4471');
  assert.strictEqual(c.dispute_claimed, 312.4);
  assert.ok(c.dispute_filed_at, 'the clock the card counts from is stamped');
  assert.strictEqual(dc.disputeIsOpen(c), true);
  assert.deepStrictEqual(dc.blockers(c), ['dispute_open']);
});

it('a carrier the system does not know is refused', () => {
  const db = fresh();
  assert.throws(() => step(db, 'claim_filed', { carrier: 'not-a-carrier' }),
    e => e.code === 'unknown_carrier');
});

it('no carrier at all is allowed — a parcel can be claimed before a waybill is on it', () => {
  const db = fresh();
  const c = step(db, 'claim_filed', { ref: 'X1' });
  assert.strictEqual(c.dispute_state, 'filed');
  assert.strictEqual(c.dispute_carrier, null);
});

// ── 5. Not claiming is a real answer, and needs a reason ───────────────────
it('choosing not to claim requires a typed reason', () => {
  const db = fresh();
  assert.throws(() => step(db, 'no_claim', {}), e => e.code === 'reason_required');
  assert.throws(() => step(db, 'no_claim', { note: '   ' }), e => e.code === 'reason_required');
});

it('not claiming finishes the dispute track, so a small spoil can be closed', () => {
  const db = fresh();
  step(db, 'customer_told');
  step(db, 'remedy', { kind: 'refund' });
  const c = step(db, 'no_claim', { note: 'under ¥50, not worth the paperwork' });
  assert.strictEqual(c.dispute_state, 'no_claim');
  assert.strictEqual(dc.disputeIsOpen(c), false);
  assert.deepStrictEqual(dc.blockers(c), []);
  assert.strictEqual(dc.canClose(c), true);
});

// ── 6. The settlement, and the figure that makes it worth recording ────────
it('a paid outcome cannot be recorded without the amount', () => {
  const db = fresh();
  step(db, 'claim_filed', { ref: 'X' });
  assert.throws(() => step(db, 'settled', { outcome: 'paid' }), e => e.code === 'amount_required');
});

it('a rejected outcome needs no amount and finishes the track', () => {
  const db = fresh();
  step(db, 'claim_filed', { ref: 'X' });
  const c = step(db, 'settled', { outcome: 'rejected', note: 'outside the cold-chain window' });
  assert.strictEqual(c.dispute_state, 'rejected');
  assert.strictEqual(c.dispute_received, null);
  assert.strictEqual(dc.disputeIsOpen(c), false);
});

it('a nonsense outcome is refused rather than stored', () => {
  const db = fresh();
  assert.throws(() => step(db, 'settled', { outcome: 'maybe' }), e => e.code === 'bad_outcome');
  assert.throws(() => step(db, 'remedy', { kind: 'vouchers' }), e => e.code === 'bad_remedy');
  assert.throws(() => dc.applyStep(db, { orderId: 100, shipmentId: 55, step: 'invent', actor: ACTOR }),
    e => e.code === 'unknown_step');
});

it('the carrier paying less than was asked is recorded as what it was', () => {
  const db = fresh();
  step(db, 'claim_filed', { claimed: '312.40' });
  const c = step(db, 'settled', { outcome: 'paid', received: '250' });
  assert.strictEqual(c.dispute_claimed, 312.4);
  assert.strictEqual(c.dispute_received, 250);
  // Nothing here posts to the ledger — §98 stage four does, and not before.
});

// ── 7. The close itself ────────────────────────────────────────────────────
it('closeCase REFUSES while the claim is with the carrier, and says why', () => {
  const db = fresh();
  step(db, 'customer_told');
  step(db, 'remedy', { kind: 'replacement' });
  step(db, 'claim_filed', { ref: 'JD-1' });
  const r = dc.closeCase(db, { orderId: 100, shipmentId: 55, actor: ACTOR });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.blockers, ['dispute_open']);
  assert.strictEqual(r.case.closed_at, null, 'and nothing was written');
});

it('closeCase succeeds once the carrier has answered', () => {
  const db = fresh();
  step(db, 'customer_told');
  step(db, 'remedy', { kind: 'replacement' });
  step(db, 'claim_filed', { ref: 'JD-1', claimed: '312.40' });
  step(db, 'settled', { outcome: 'paid', received: '250' });
  const r = dc.closeCase(db, { orderId: 100, shipmentId: 55, actor: ACTOR });
  assert.strictEqual(r.ok, true);
  assert.ok(r.case.closed_at);
  assert.strictEqual(r.case.closed_by, 'mei');
});

it('a closed case refuses further steps, and reopening lets them through again', () => {
  const db = fresh();
  step(db, 'customer_told');
  step(db, 'remedy', { kind: 'refund' });
  step(db, 'no_claim', { note: 'small' });
  dc.closeCase(db, { orderId: 100, shipmentId: 55, actor: ACTOR });
  assert.throws(() => step(db, 'note', { note: 'late thought' }), e => e.code === 'case_closed');
  const re = dc.reopenCase(db, { orderId: 100, shipmentId: 55, actor: ACTOR });
  assert.strictEqual(re.closed_at, null);
  assert.doesNotThrow(() => step(db, 'note', { note: 'late thought' }));
});

// ── 8. The timeline ────────────────────────────────────────────────────────
it('every step leaves an event, in the order it happened, with who did it', () => {
  const db = fresh();
  step(db, 'customer_told');
  step(db, 'claim_filed', { ref: 'JD-1', claimed: '10' });
  step(db, 'remedy', { kind: 'replacement' });
  step(db, 'settled', { outcome: 'paid', received: '10' });
  const c = dc.readCase(db, 55);
  const evs = dc.caseEvents(db, c.id);
  assert.deepStrictEqual(evs.map(e => e.event),
    ['opened', 'customer_told', 'claim_filed', 'remedy_replacement', 'settled']);
  assert.ok(evs.every(e => e.user_label === 'mei'));
  // Re-filing a claim writes a second event rather than being refused — a typo
  // in a claim number must not need a database to fix.
  step(db, 'claim_filed', { ref: 'JD-2' });
  assert.strictEqual(dc.caseEvents(db, c.id).length, 6);
  assert.strictEqual(dc.readCase(db, 55).dispute_ref, 'JD-2');
});

it('forScreen hands both surfaces the same answer', () => {
  const db = fresh();
  step(db, 'customer_told');
  step(db, 'claim_filed', { ref: 'JD-1' });
  const v = dc.forScreen(db, dc.readCase(db, 55));
  assert.strictEqual(v.can_close, false);
  assert.strictEqual(v.dispute_open, true);
  assert.deepStrictEqual(v.blockers.sort(), ['customer_not_made_whole', 'dispute_open']);
  assert.ok(Array.isArray(v.events) && v.events.length >= 3);
});

console.log('\n  driver: better-sqlite3\n');
if (fails.length) {
  console.log(`  ${pass} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log(`  ${pass} passed, 0 failed`);
