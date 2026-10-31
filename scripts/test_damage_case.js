#!/usr/bin/env node
/**
 * A parcel that arrived on time but damaged gets the same case as a late one,
 * and opening it touches no alert (§424).
 *
 *   node scripts/test_damage_case.js
 *
 * WHY THIS EXISTS. The case panel with Send replacement drew only for a LATE
 * parcel, so a parcel that landed on time and broken had no proper path and staff
 * raised a hand-typed no-charge order — one nothing marks as a replacement, so it
 * counted in order totals and average order value and was linked to no claim.
 * §424 gives that parcel the same four-step case through one new way in.
 *
 * WHAT IT LOCKS DOWN, in order of what would actually hurt:
 *   1. Report damage opens a case marked 'damaged' on a delivered, on-time parcel
 *      — and nothing else: it is the way in, not a stock or money move.
 *   2. It refuses a parcel that has not landed, refuses a late one (that has its
 *      own panel and a parcel has ONE case), and is harmless on a double-tap.
 *   3. A damage case closes by its own rule and its own function, and closing it
 *      never writes air_delay_cleared_at — the one flag every worklist reads.
 *      A late case cannot be closed through the damage route at all.
 *   4. THE LATE-PARCEL ALERT WAS NOT WIDENED. The predicates that decide what is
 *      late and what is on "Delivery needs a call" do not mention the new reason
 *      (§98 addendum 6 is what widening them did last time).
 *   5. Both screens carry the way in, the handled line and the damage wording, and
 *      every Chinese string composed for it is declared in the vocabulary doc.
 *
 * THE SCHEMA IS READ OUT OF THE SHIPPED FILE, not copied here, as
 * scripts/test_delay_case.js does and for the same reason.
 *
 * No network, no keys, no server — an in-memory SQLite and lib/delay-case.js.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('@libsql/client');
// Every shop in this suite is a Guangzhou shop, and says so (§82): the rules
// take the shop's zone and day shift, and there is no default to lean on. The
// real module, with Guangzhou passed wherever a call here leaves it out.
const GZ_TZ = 'Asia/Shanghai';
const GZ_SHIFT = require('../lib/business-date').sqlDayShift(GZ_TZ);
const dc = Object.assign(Object.create(require('../lib/delay-case')), {
  lateDays: (s, tz = GZ_TZ) => require('../lib/delay-case').lateDays(s, tz),
  runningLateDays: (s, now = new Date(), tz = GZ_TZ) => require('../lib/delay-case').runningLateDays(s, now, tz),
  lateAfterSql: (a, sh = GZ_SHIFT) => require('../lib/delay-case').lateAfterSql(a, sh),
  attemptedOnTimeSql: (a, sh = GZ_SHIFT) => require('../lib/delay-case').attemptedOnTimeSql(a, sh),
  lateShipmentSql: (a, sh = GZ_SHIFT) => require('../lib/delay-case').lateShipmentSql(a, sh),
  runningLateSql: (a, today = null, sh = GZ_SHIFT) => require('../lib/delay-case').runningLateSql(a, today, sh),
  runningLateSinceSql: (a, sh = GZ_SHIFT) => require('../lib/delay-case').runningLateSinceSql(a, sh),
  runningLateNeedsCallSql: (a, today = null, now = "datetime('now')", sh = GZ_SHIFT) =>
    require('../lib/delay-case').runningLateNeedsCallSql(a, today, now, sh),
});

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// ── The shipped schema, lifted ─────────────────────────────────────────────
const DB_SRC = read('database.js');
const CASES = DB_SRC.match(/db\.exec\(`(\s*CREATE TABLE IF NOT EXISTS retail_delay_cases[\s\S]*?)`\);/);
const FILES = DB_SRC.match(/db\.exec\(`(\s*CREATE TABLE IF NOT EXISTS retail_delay_case_files[\s\S]*?)`\);/);
const REASON_COL = DB_SRC.match(/addColumn\('retail_delay_cases',\s*'reason',\s*'([A-Z]+)'\)/);
if (!CASES || !FILES) {
  console.error('could not find the delay-case schema in database.js — fix this test rather than deleting it');
  process.exit(1);
}

function fresh() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_orders    (id INTEGER PRIMARY KEY);
    CREATE TABLE retail_shipments (id INTEGER PRIMARY KEY);
    -- The shop's zone, as Roots carries it (§82): "late" is judged on its days.
    CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);
    INSERT INTO storefront_config (key, value_json) VALUES ('shop.timezone', '"Asia/Shanghai"');
  `);
  db.exec(CASES[1]);
  db.exec(FILES[1]);
  // The column arrives by addColumn in production, so it arrives the same way
  // here — lifted from the shipped line, type and all.
  if (REASON_COL) db.exec(`ALTER TABLE retail_delay_cases ADD COLUMN reason ${REASON_COL[1]}`);
  db.prepare('INSERT INTO retail_orders (id) VALUES (100)').run();
  db.prepare('INSERT INTO retail_shipments (id) VALUES (55)').run();
  db.prepare('INSERT INTO retail_shipments (id) VALUES (56)').run();
  return db;
}

const ACTOR = { id: 7, label: 'mei' };
// An air parcel, dispatched 1 Oct. Delivered 2 Oct is ON TIME (air allows one
// day); delivered 5 Oct is three days late.
const onTime  = { id: 55, mode: 'air', dispatched_at: '2026-10-01 09:00:00', delivered_at: '2026-10-02 15:00:00' };
const late    = { id: 56, mode: 'air', dispatched_at: '2026-10-01 09:00:00', delivered_at: '2026-10-05 15:00:00' };
const onRoad  = { id: 55, mode: 'air', dispatched_at: '2026-10-01 09:00:00', delivered_at: null, tracking_status: 'in_transit' };
const report  = (db, shipment) => dc.reportDamage(db, { orderId: 100, shipment, actor: ACTOR });
const step    = (db, sid, step_, payload) =>
  dc.applyStep(db, { orderId: 100, shipmentId: sid, step: step_, payload: payload || {}, actor: ACTOR });

// ── 0. The fixtures mean what they say ─────────────────────────────────────
it('the on-time fixture is on time and the late fixture is late', () => {
  assert.strictEqual(dc.lateDays(onTime), 0);
  assert.ok(dc.lateDays(late) > 0, 'the late fixture must be late or test 2 proves nothing');
});

// ── 1. The way in opens a damage case and nothing else ─────────────────────
it('the reason column is declared in the shipped schema', () => {
  assert.ok(REASON_COL, "database.js must addColumn('retail_delay_cases', 'reason', 'TEXT')");
});

it('reporting damage on a delivered, on-time parcel opens a case marked damaged', () => {
  const db = fresh();
  const r = report(db, onTime);
  assert.ifError(r.error);
  assert.strictEqual(r.case.reason, 'damaged');
  assert.strictEqual(r.case.order_id, 100);
  assert.strictEqual(r.case.shipment_id, 55);
  assert.strictEqual(dc.forScreen(db, r.case).reason, 'damaged');
});

it('it opens a row and moves nothing: no step taken, still blocked on all three tracks', () => {
  const db = fresh();
  const c = report(db, onTime).case;
  assert.strictEqual(c.customer_told_at, null);
  assert.strictEqual(c.remedy, null);
  assert.strictEqual(c.dispute_state, 'none');
  assert.deepStrictEqual(dc.blockers(c).sort(),
    ['customer_not_made_whole', 'customer_not_told', 'dispute_open']);
});

it('the timeline records who reported it', () => {
  const db = fresh();
  const c = report(db, onTime).case;
  const ev = dc.caseEvents(db, c.id).map(e => e.event);
  assert.ok(ev.includes('damage_reported'), 'got ' + ev.join(','));
  assert.strictEqual(dc.caseEvents(db, c.id).find(e => e.event === 'damage_reported').user_label, 'mei');
});

it('every case that predates the column reads as late', () => {
  const db = fresh();
  const c = dc.ensureCase(db, 100, 56, ACTOR);          // the late path, untouched
  assert.strictEqual(dc.forScreen(db, c).reason, 'late');
});

// ── 2. The refusals ────────────────────────────────────────────────────────
it('a parcel that has not landed cannot have arrived damaged', () => {
  const db = fresh();
  assert.strictEqual(report(db, onRoad).error, 'not_delivered');
  assert.strictEqual(dc.readCase(db, 55), null, 'a refusal must not leave a row behind');
});

it('a late parcel is refused — it already has its panel, and a parcel has one case', () => {
  const db = fresh();
  assert.strictEqual(report(db, late).error, 'is_late');
  assert.strictEqual(dc.readCase(db, 56), null);
});

it('a parcel that already has a late case is refused, not re-marked', () => {
  const db = fresh();
  dc.ensureCase(db, 100, 55, ACTOR);                    // a case with no reason
  assert.strictEqual(report(db, onTime).error, 'case_exists');
  assert.strictEqual(dc.readCase(db, 55).reason, null);
});

it('a double-tap is harmless: the same case comes back and no second event is written', () => {
  const db = fresh();
  const a = report(db, onTime).case;
  const b = report(db, onTime).case;
  assert.strictEqual(a.id, b.id);
  const n = dc.caseEvents(db, a.id).filter(e => e.event === 'damage_reported').length;
  assert.strictEqual(n, 1);
});

it('a missing parcel is refused by name', () => {
  assert.strictEqual(report(fresh(), null).error, 'not_found');
});

// ── 3. Closing it ──────────────────────────────────────────────────────────
const close = (db, sid, closed) =>
  dc.setDamageCaseClosed(db, { orderId: 100, shipmentId: sid, closed, actor: ACTOR });

it('a damage case will not close until the same three tracks are answered', () => {
  const db = fresh();
  report(db, onTime);
  const r = close(db, 55, true);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.blockers.sort(),
    ['customer_not_made_whole', 'customer_not_told', 'dispute_open']);
  assert.strictEqual(dc.readCase(db, 55).closed_at, null);
});

it('a filed carrier claim holds it open, exactly as on a late case', () => {
  const db = fresh();
  report(db, onTime);
  step(db, 55, 'customer_told');
  step(db, 55, 'remedy', { kind: 'replacement', note: 'TC000999' });
  step(db, 55, 'claim_filed', { ref: 'CL-1', claimed: '120', carrier: 'jd' });
  const r = close(db, 55, true);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.blockers, ['dispute_open']);
});

it('once every track is answered it closes, and can be reopened', () => {
  const db = fresh();
  report(db, onTime);
  step(db, 55, 'customer_told');
  step(db, 55, 'remedy', { kind: 'replacement', note: 'TC000999' });
  step(db, 55, 'no_claim', { note: 'small, not worth claiming' });
  const r = close(db, 55, true);
  assert.strictEqual(r.ok, true);
  assert.ok(dc.readCase(db, 55).closed_at, 'closed_at must be set');
  assert.strictEqual(dc.readCase(db, 55).closed_by, 'mei');
  const back = close(db, 55, false);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(dc.readCase(db, 55).closed_at, null);
});

it('the damage route cannot close a LATE case, or a parcel with none', () => {
  const db = fresh();
  dc.ensureCase(db, 100, 56, ACTOR);                    // a late case
  assert.strictEqual(close(db, 56, true).error, 'not_damage_case');
  assert.strictEqual(close(db, 55, true).error, 'not_damage_case');   // no case at all
  assert.strictEqual(dc.readCase(db, 56).closed_at, null);
});

// ── 4. The late-parcel alert was not widened ───────────────────────────────
// Sliced out of the shipped source by name, so a rename fails here rather than
// quietly making the assertion vacuous.
function fnSource(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('could not find function ' + name);
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j + 3);
}
const LIB = read('lib/delay-case.js');

it('the alert predicates do not mention the new reason', () => {
  for (const name of ['lateShipmentSql', 'lateDays', 'lateAfterSql', 'runningLateSql', 'runningLateDays']) {
    const body = fnSource(LIB, name);
    assert.ok(!/damaged|\breason\b/.test(body), name + ' must not read the damage reason (§424)');
  }
});

it('LATE_AFTER_DAYS is unchanged', () => {
  assert.deepStrictEqual({ ...dc.LATE_AFTER_DAYS }, { air: 1, local: 1, land: 3 });
});

const ROUTES = read('routes/retail.js');

it('closing a damage case never writes air_delay_cleared_at', () => {
  const lib = fnSource(LIB, 'setDamageCaseClosed');
  assert.ok(!/air_delay_cleared/.test(lib));
  const i = ROUTES.indexOf("'/api/retail-admin/orders/:id/delay-case/close'");
  assert.ok(i > 0, 'the close route must exist');
  const route = ROUTES.slice(i, ROUTES.indexOf('\n});\n', i));
  assert.ok(!/air_delay_cleared/.test(route), 'the damage close route must not touch the worklist stamp');
});

it('the air-delay ack route and orderHasDelayedParcel were not changed to know about damage', () => {
  const i = ROUTES.indexOf("'/api/retail-admin/orders/:id/air-delay/ack'");
  assert.ok(i > 0, 'the air-delay ack route must exist, or this assertion is vacuous');
  const ack = ROUTES.slice(i, ROUTES.indexOf('\n});\n', i));
  assert.ok(!/damaged|reportDamage|setDamageCaseClosed/.test(ack));
  const j = ROUTES.indexOf('function orderHasDelayedParcel(');
  assert.ok(j > 0, 'orderHasDelayedParcel must exist, or this assertion is vacuous');
  const fn = ROUTES.slice(j, ROUTES.indexOf('\n}\n', j));
  assert.ok(!/damaged|reason/.test(fn));
});

it('the report route is a thin wrapper over the library rule', () => {
  const i = ROUTES.indexOf("'/api/retail-admin/orders/:id/delay-case/report-damage'");
  assert.ok(i > 0, 'the report-damage route must exist');
  const route = ROUTES.slice(i, ROUTES.indexOf('\n});\n', i));
  assert.ok(/delayCase\.reportDamage\(/.test(route), 'the refusals live in lib/delay-case.js');
  assert.ok(!/INSERT|UPDATE/.test(route), 'the route writes through the library, never directly');
});

// ── 5. Both screens, and the vocabulary ────────────────────────────────────
const DESK  = read('public/retail-admin/04-orders.js');
const PHONE = read('public/m.html');
const VOCAB = read('docs/tacet-delivery-vocabulary.md');

// The five strings composed for §424. Each must be declared in the vocabulary
// document AND be the Chinese the screens actually print.
const COMPOSED = [
  ['Report damage',                    '登记破损'],
  ['Parcel damaged',                   '包裹破损'],
  ['Claim the damage off the carrier', '向承运商申请赔偿'],
  ['Claim filed',                      '已申请赔偿'],
  ['Damage handled',                   '破损已处理'],
];

it('both screens offer Report damage and call the route', () => {
  assert.ok(/delay-case\/report-damage/.test(DESK), 'desktop must call the report route');
  assert.ok(/delay-case\/report-damage/.test(PHONE), 'phone must call the report route');
  assert.ok(/delay-case\/close/.test(DESK) && /delay-case\/close/.test(PHONE),
    'both must close a damage case through its own route, not /air-delay/ack');
});

it('both screens print every composed string, in both languages', () => {
  for (const [en, zh] of COMPOSED) {
    assert.ok(DESK.includes(en) && DESK.includes(zh), 'desktop is missing ' + en + ' · ' + zh);
    assert.ok(PHONE.includes(en) && PHONE.includes(zh), 'phone is missing ' + en + ' · ' + zh);
  }
});

it('every composed string is declared in the vocabulary document, as composed', () => {
  // The SECTION, not the first mention: the first mention of this heading is the
  // changelog line at the top of the file, and slicing from there to the end of
  // the document would pass on a 'Composed' table belonging to any later section.
  const at = VOCAB.lastIndexOf("\n## A damaged parcel's case (§424)");
  assert.ok(at > 0, 'the §424 section must exist');
  const next = VOCAB.indexOf('\n## ', at + 4);
  const sec = VOCAB.slice(at, next < 0 ? undefined : next);
  assert.ok(sec.includes('### Composed'), 'the §424 section must have its own Composed table');
  const composed = sec.slice(sec.indexOf('### Composed'));
  for (const [, zh] of COMPOSED) {
    assert.ok(composed.includes('`' + zh + '`'), zh + ' is on a screen but not declared composed');
  }
  assert.ok(/^\*\*v1\.308 ·/m.test(VOCAB), 'the vocabulary version line must be bumped');
});

it('a damage case never shows the late case\'s food-safety line', () => {
  // Both screens gate that sentence on `damaged`.
  assert.ok(/detail: damaged \? ''/.test(DESK), 'desktop must drop the food-safety detail on a damage case');
  assert.ok(/detail:damaged\?''/.test(PHONE), 'phone must drop the food-safety detail on a damage case');
});

it('neither screen offers Report damage on a late parcel', () => {
  assert.ok(/delayDays === 0 && !s\.delay_case/.test(DESK), 'desktop gate');
  assert.ok(/if\(sp\.lateDays>0\) return ''/.test(PHONE), 'phone gate');
});

console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) process.exit(1);
