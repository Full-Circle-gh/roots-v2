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
// The evidence table is its own db.exec, so it is lifted separately rather than
// hand-copied — same reason as the block above.
const FILES = DB_SRC.match(
  /db\.exec\(`(\s*CREATE TABLE IF NOT EXISTS retail_delay_case_files[\s\S]*?)`\);/
);
if (!FILES) {
  console.error('could not find the retail_delay_case_files schema in database.js');
  process.exit(1);
}
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
  db.exec(FILES[1]);
  db.prepare('INSERT INTO retail_orders (id) VALUES (100)').run();
  db.prepare('INSERT INTO retail_shipments (id) VALUES (55)').run();
  return db;
}

// A shipments-only fixture for the lateness tests. It carries an EMPTY
// retail_delay_cases because the predicate's escape clause names that table —
// empty is the normal case and the one the cutover has to hold for.
function shipFixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_shipments (
             id INTEGER PRIMARY KEY, mode TEXT, dispatched_at TEXT,
             delivered_at TEXT, tracking_status TEXT, tracking_synced_at TEXT);
           CREATE TABLE retail_delay_cases (
             id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, shipment_id INTEGER);`);
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

// ── 5b. Nothing is owed, and that is also a real answer (§125) ─────────────
// The case that had no exit: a late parcel arrives, the customer opens it, the
// food is fine. No goods go back out and no money goes back, but the make-whole
// step still had to be answered or `customer_not_made_whole` sat on the case
// for good — so the operator's only ways out were a no-charge replacement
// order nobody wanted or a refund that never happened.
it('nothing needed finishes the make-whole track without goods or money', () => {
  const db = fresh();
  step(db, 'customer_told');
  const c = step(db, 'remedy', { kind: 'none', note: 'customer confirmed the food was fine' });
  assert.strictEqual(c.remedy, 'none');
  assert.strictEqual(c.remedy_note, 'customer confirmed the food was fine');
  assert.ok(c.remedy_at, 'and it is stamped like any other answer');
  assert.ok(!dc.blockers(c).includes('customer_not_made_whole'),
    'the make-whole step is ANSWERED — the question is not whether anything was given');
});

it('nothing needed requires a typed reason, exactly as not claiming does', () => {
  const db = fresh();
  assert.throws(() => step(db, 'remedy', { kind: 'none' }), e => e.code === 'reason_required');
  assert.throws(() => step(db, 'remedy', { kind: 'none', note: '   ' }),
    e => e.code === 'reason_required');
  // And the case is untouched by the refusal.
  assert.strictEqual(dc.readCase(db, 55).remedy, null);
});

it('the other two answers still need no reason — they evidence themselves', () => {
  const db = fresh();
  assert.doesNotThrow(() => step(db, 'remedy', { kind: 'replacement' }));
  assert.doesNotThrow(() => step(db, 'remedy', { kind: 'refund' }));
});

it('the screenshot case closes: told, not claiming, nothing owed', () => {
  // The live case this was found on. Every track answered, nothing given, and
  // before §125 the footer read `to do: Replacement or refund` for ever.
  const db = fresh();
  step(db, 'customer_told');
  step(db, 'no_claim', { note: 'customer confirmed the food arrived in good condition' });
  const c = step(db, 'remedy', { kind: 'none', note: 'customer confirmed the food arrived in good condition' });
  assert.deepStrictEqual(dc.blockers(c), []);
  assert.strictEqual(dc.canClose(c), true);
  const r = dc.closeCase(db, { orderId: 100, shipmentId: 55, actor: ACTOR });
  assert.strictEqual(r.ok, true);
  assert.ok(r.case.closed_at);
});

it('nothing needed leaves its own event, tellable from a replacement or a refund', () => {
  const db = fresh();
  step(db, 'remedy', { kind: 'none', note: 'food was fine' });
  const c = dc.readCase(db, 55);
  assert.deepStrictEqual(dc.caseEvents(db, c.id).map(e => e.event), ['opened', 'remedy_none']);
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

// ── When a parcel is late enough to raise a case ───────────────────────────
// Widened from air-only on 2026-09-11. The hole it closed: `planShipments`
// sends EVERY Guangdong order by land "regardless of any item's air flag", so
// the province closest to the kitchen — ice packs included — was the one
// destination whose late parcels raised nothing at all.
it('the thresholds are per mode, and air is unchanged', () => {
  assert.strictEqual(dc.LATE_AFTER_DAYS.air, 1, 'air is the live rule and must not move');
  assert.strictEqual(dc.LATE_AFTER_DAYS.local, 1);
  assert.strictEqual(dc.LATE_AFTER_DAYS.land, 3);
  assert.throws(() => { dc.LATE_AFTER_DAYS.air = 9; });
});

it('lateDays counts from each mode\'s own allowance', () => {
  const p = (mode, dispatched, delivered) => ({ mode, dispatched_at: dispatched, delivered_at: delivered });
  // DATES AFTER THE CUTOVER, so this measures the thresholds and nothing else —
  // a pre-cutover date returns 0 for a different reason and would hide a
  // threshold that had drifted.
  // Air: one day allowed.
  assert.strictEqual(dc.lateDays(p('air', '2026-09-20', '2026-09-21')), 0, 'a day is on time');
  assert.strictEqual(dc.lateDays(p('air', '2026-09-20', '2026-09-23')), 2);
  // Land: three. Two days is ordinary ground freight and must NOT raise a case,
  // or the badge is noise inside a week and stops being read.
  assert.strictEqual(dc.lateDays(p('land', '2026-09-20', '2026-09-22')), 0);
  assert.strictEqual(dc.lateDays(p('land', '2026-09-20', '2026-09-25')), 2);
  // Local: same-city, same-day promise.
  assert.strictEqual(dc.lateDays(p('local', '2026-09-20', '2026-09-22')), 1);
  // A mode with no threshold never raises — supplier-direct is not ours to claim.
  assert.strictEqual(dc.lateDays(p('supplier', '2026-09-01', '2026-10-01')), 0);
  // Missing stamps are not lateness.
  assert.strictEqual(dc.lateDays(p('air', null, '2026-09-23')), 0);
  assert.strictEqual(dc.lateDays(p('air', '2026-09-20', null)), 0);
});

it('the SQL and the JS agree — they are two renderings of one rule', () => {
  const db = shipFixture();
  const ins = db.prepare(
    'INSERT INTO retail_shipments (id,mode,dispatched_at,delivered_at) VALUES (?,?,?,?)');
  const rows = [
    [1, 'air',      '2026-09-20', '2026-09-21'],  // on time
    [2, 'air',      '2026-09-20', '2026-09-23'],  // 2 late
    [3, 'land',     '2026-09-20', '2026-09-22'],  // ordinary ground freight
    [4, 'land',     '2026-09-20', '2026-09-25'],  // 2 late
    [5, 'local',    '2026-09-20', '2026-09-22'],  // 1 late
    [6, 'supplier', '2026-09-01', '2026-10-01'],  // never ours
  ];
  rows.forEach(r => ins.run(...r));

  const lateIds = db.prepare(
    `SELECT id FROM retail_shipments WHERE ${dc.lateShipmentSql()} ORDER BY id`
  ).all().map(r => r.id);
  assert.deepStrictEqual(lateIds, [2, 4, 5]);

  // The same six through the JS. If these ever disagree, one of the two screens
  // shows a badge the query behind it will not produce.
  const jsLate = rows
    .filter(([, mode, d, del]) => dc.lateDays({ mode, dispatched_at: d, delivered_at: del }) > 0)
    .map(([id]) => id);
  assert.deepStrictEqual(jsLate, lateIds, 'the SQL and the JS disagree about which parcels are late');

  // And the alias form, which three of the four call sites use.
  const aliased = db.prepare(
    `SELECT COUNT(*) AS n FROM retail_shipments sha WHERE ${dc.lateShipmentSql('sha')}`).get();
  assert.strictEqual(aliased.n, 3);
});

it('a delivered-status parcel with no delivered_at still counts — JD never stamps it', () => {
  const db = shipFixture();
  db.prepare(`INSERT INTO retail_shipments
    (id,mode,dispatched_at,delivered_at,tracking_status,tracking_synced_at)
    VALUES (1,'air','2026-09-20',NULL,'delivered','2026-09-24')`).run();
  const n = db.prepare(
    `SELECT COUNT(*) AS n FROM retail_shipments WHERE ${dc.lateShipmentSql()}`).get().n;
  assert.strictEqual(n, 1, 'the tracking_synced_at fallback is load-bearing for JD live sync');
});

// ── The evidence sent to the carrier ───────────────────────────────────────
it('a photograph attaches, and the bytes never come back with the list', () => {
  const db = fresh();
  const c = dc.ensureCase(db, 100, 55, ACTOR);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const fid = dc.addCaseFile(db, c.id, { data: png, label: 'spoiled greens', actor: ACTOR });

  const listed = dc.caseFiles(db, c.id);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].label, 'spoiled greens');
  assert.strictEqual(listed[0].uploaded_by_label, 'mei');
  assert.strictEqual(listed[0].bytes, png.length);
  // THE POINT. A case with six photographs must not put six photographs into
  // every order-detail payload that mentions it.
  assert.strictEqual(listed[0].data, undefined, 'the list must not carry the bytes');
  assert.ok(!('data' in listed[0]), 'the list must not carry the bytes');

  // forScreen is what both surfaces actually receive.
  const v = dc.forScreen(db, dc.readCase(db, 55));
  assert.strictEqual(v.files.length, 1);
  assert.ok(!('data' in v.files[0]), 'forScreen must not carry the bytes either');

  // And the picture itself, when somebody asks for it by id.
  assert.strictEqual(dc.caseFileData(db, c.id, fid).data, png);
});

it('anything that is not an image is refused', () => {
  const db = fresh();
  const c = dc.ensureCase(db, 100, 55, ACTOR);
  for (const bad of ['', 'hello', 'https://example.com/x.png',
                     'data:text/html;base64,PHNjcmlwdD4=',
                     'javascript:alert(1)']) {
    assert.throws(() => dc.addCaseFile(db, c.id, { data: bad, actor: ACTOR }),
      e => e.code === 'bad_image', 'should refuse: ' + bad);
  }
  assert.strictEqual(dc.caseFiles(db, c.id).length, 0);
});

it('a file is reachable only through its own case', () => {
  const db = fresh();
  db.prepare('INSERT INTO retail_shipments (id) VALUES (56)').run();
  const a = dc.ensureCase(db, 100, 55, ACTOR);
  const b = dc.ensureCase(db, 100, 56, ACTOR);
  const fid = dc.addCaseFile(db, a.id, { data: 'data:image/jpeg;base64,AAA=', actor: ACTOR });
  // The id alone is not a key — the other case cannot read or delete it.
  assert.strictEqual(dc.caseFileData(db, b.id, fid), null);
  assert.strictEqual(dc.removeCaseFile(db, b.id, fid), false);
  assert.ok(dc.caseFileData(db, a.id, fid));
  assert.strictEqual(dc.removeCaseFile(db, a.id, fid), true);
  assert.strictEqual(dc.caseFiles(db, a.id).length, 0);
});

it('evidence does not gate closing — a case can finish without photographs', () => {
  const db = fresh();
  step(db, 'customer_told');
  step(db, 'remedy', { kind: 'refund' });
  step(db, 'no_claim', { note: 'small' });
  assert.strictEqual(dc.canClose(dc.readCase(db, 55)), true);
});

// ── The cutover ────────────────────────────────────────────────────────────
// Ash, 2026-09-11, off the live phone: "no need to raise a case for previous
// orders, only from today". Widening the alert past air had asked the same
// question of every parcel ever shipped and lit up the whole history — the
// oldest seventy-nine days — on the one card whose job is to list work that
// will actually be done.
it('a parcel delivered before the cutover raises nothing, whatever its mode', () => {
  const db = shipFixture();
  const ins = db.prepare('INSERT INTO retail_shipments (id,mode,dispatched_at,delivered_at) VALUES (?,?,?,?)');
  ins.run(1, 'air',  '2026-06-20', '2026-06-24');   // 79 days old, badly late
  ins.run(2, 'land', '2026-09-01', '2026-09-08');   // late, but before today
  ins.run(3, 'land', '2026-09-06', '2026-09-11');   // delivered ON the cutover
  ins.run(4, 'air',  '2026-09-11', '2026-09-13');   // after it
  const late = db.prepare(
    `SELECT id FROM retail_shipments WHERE ${dc.lateShipmentSql()} ORDER BY id`).all().map(r => r.id);
  assert.deepStrictEqual(late, [3, 4],
    'only parcels delivered on or after the cutover may raise a case');
});

it('lateDays mirrors the cutover, so no screen disagrees with the query', () => {
  // A drawer drawing a checklist the dashboard has filtered out is one screen
  // saying there is work and two saying there is none.
  assert.strictEqual(dc.lateDays({ mode: 'air', dispatched_at: '2026-06-20', delivered_at: '2026-06-24' }), 0);
  assert.strictEqual(dc.lateDays({ mode: 'land', dispatched_at: '2026-09-01', delivered_at: '2026-09-08' }), 0);
  assert.ok(dc.lateDays({ mode: 'air', dispatched_at: '2026-09-11', delivered_at: '2026-09-13' }) > 0);
});

it('a parcel somebody already opened a case on stays in scope, however old', () => {
  // THE ESCAPE HATCH, exercised rather than asserted about. Without it a dispute
  // already being chased would vanish from the card mid-chase — the exact
  // failure §98 exists to prevent.
  const db = shipFixture();
  db.prepare(`INSERT INTO retail_shipments (id,mode,dispatched_at,delivered_at)
              VALUES (1,'air','2026-06-20','2026-06-24')`).run();
  const q = `SELECT COUNT(*) AS n FROM retail_shipments WHERE ${dc.lateShipmentSql()}`;
  assert.strictEqual(db.prepare(q).get().n, 0, 'untouched and pre-cutover: filtered out');

  db.prepare('INSERT INTO retail_delay_cases (order_id, shipment_id) VALUES (100, 1)').run();
  assert.strictEqual(db.prepare(q).get().n, 1, 'a case row brings it back into scope');
});

it('the cutover is a fixed date, not a rolling window', () => {
  assert.match(dc.CASES_FROM, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(dc.lateShipmentSql().includes(`>= '${dc.CASES_FROM}'`));
});

it('no file hand-writes the lateness rule any more', () => {
  const files = ['routes/retail.js', 'public/retail-admin/04-orders.js', 'public/m.html'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!src.includes("'+1 day'"),
      `${f} re-introduces a hand-written lateness threshold — use lib/delay-case.js`);
  }
});

it('both surfaces render the blockers this file computes', () => {
  // §98 has returned `blockers` on every case since it was written and NEITHER
  // SCREEN DREW THEM: both printed "close once every step above is done", which
  // sends the operator back to re-read a list the server has already read. The
  // codes are worded per surface, deliberately — this file's own `blockers()`
  // header says why — so what is asserted here is that each surface reads them
  // at all, not how it words them.
  for (const f of ['public/retail-admin/04-orders.js', 'public/m.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(/\.blockers\b/.test(src),
      `${f} never reads dc.blockers — the refusal cannot say what it is waiting for`);
    for (const code of ['customer_not_told', 'customer_not_made_whole', 'dispute_open']) {
      assert.ok(src.includes(code), `${f} has no wording for blocker ${code}`);
    }
  }
});

it('both surfaces offer the third answer, and neither offers it as a button', () => {
  // §125. The reason this is asserted on the SOURCE rather than on the rule is
  // that the rule cannot go wrong quietly — a screen can. A surface that gains
  // `none` as a third filled button has undone §98's one-primary hierarchy, and
  // a surface that never gains it at all leaves its operators the dead end this
  // section exists to remove, with the other surface looking fine.
  for (const f of ['public/retail-admin/04-orders.js', 'public/m.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(src.includes('无需补发退款'),
      `${f} has no way to say nothing was owed — the make-whole step is a dead end there`);
    assert.ok(/kind:\s*'none'|kind:'none'/.test(src),
      `${f} never sends remedy kind 'none'`);
    // It rides `link`, which both renderers draw quietly; `acts` is where the
    // buttons live and is where it must NOT be. Matched by looking back from the
    // label rather than forward from `link:` — the desktop's control carries a
    // `${...}` interpolation, so anything of the [^}]* shape stops short of it.
    const drawnAsLink = src.split('无需补发退款')
      .slice(0, -1)
      .some(before => /\blink\s*:\s*\{[^;]*$/.test(before.slice(-200)));
    assert.ok(drawnAsLink,
      `${f} draws 'nothing needed' outside link:{} — an opt-out that ends a track is not a button`);
  }
});

console.log('\n  driver: better-sqlite3\n');
if (fails.length) {
  console.log(`  ${pass} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log(`  ${pass} passed, 0 failed`);
