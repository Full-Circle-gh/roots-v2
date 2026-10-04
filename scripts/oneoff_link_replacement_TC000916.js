#!/usr/bin/env node
/**
 * One-off: link order TC000916 to TC000902 as its replacement.
 *
 * Ash's instruction, 2026-10-04: "fix TC000916 so it links to TC000902".
 *
 * ── WHAT HAPPENED ──────────────────────────────────────────────────────────
 * TC000902 arrived with damaged goods. A no-charge order, TC000916, was raised
 * for it (shop note "Replacement for TC000902"). Whether that was done through
 * the case panel's Send replacement or typed by hand is exactly what this script
 * finds out: an order raised the proper way carries `replacement_for_order_id`;
 * one raised by hand does not, and so counts as a real order in order totals and
 * average order value (lib/finance-window.js paidWhere, §98 addendum 4), and
 * TC000902's drawer never says a replacement went out.
 *
 * ── WHAT THIS WRITES ───────────────────────────────────────────────────────
 *   1. retail_orders.replacement_for_order_id on TC000916 -> TC000902's id.
 *      That one column is what takes it out of the order count and the average
 *      (§98 addendum 4) and says what it is a replacement for.
 *   2. IF TC000902 has exactly one parcel, and it has been delivered: that
 *      parcel's case (opened here if it has none — a damage case, or the late
 *      case if the parcel was late), with the make-whole step answered
 *      'replacement' and remedy_order_id = TC000916, and
 *      retail_orders.replacement_case_id on TC000916 pointing back. This is
 *      what makes TC000902's drawer read "Replacement sent". Through the SAME
 *      lib/delay-case.js functions the screens use — no second way of writing a
 *      case.
 *   3. One activity_log row, because a link nobody can trace is how the next
 *      person gets this wrong.
 * Anything else about the case is left where it was: the customer-told step, the
 * carrier claim and the evidence are the operator's to take, not a script's.
 *
 * ── WHAT IT DOES NOT TOUCH ─────────────────────────────────────────────────
 *   • MONEY. Neither order's subtotal, total or payments are written. No
 *     ledger row is created: the replacement goods were expensed at purchase and
 *     the carrier's payment, if any, is posted by the case when it is marked paid.
 *   • STOCK. TC000916 is an ordinary order and takes stock off at Preparing
 *     exactly as it already does. This changes no quantity.
 *   • `source` and `channel` on TC000916. The replacement route stamps
 *     source = 'replacement'; this does not, because the only thing that column
 *     changes is platform-channel stock (lib/inventory.js), and the script
 *     REFUSES a meituan/eleme order rather than guess about that.
 *   • `remedy_cost`. What the replacement cost is not known here and is not made
 *     up; the case shows no cost rather than a wrong one.
 *
 * ── IT REFUSES, RATHER THAN IMPROVISES, UNLESS ─────────────────────────────
 *   both orders exist; TC000916 is a genuine no-charge order (subtotal, total
 *   and every line ¥0); it is the same customer as TC000902; it was placed after
 *   TC000902; TC000902 is not itself a replacement; and TC000916 is not already
 *   linked to some OTHER order. Already linked to TC000902 is a no-op, not an
 *   error: a second run changes nothing and says so.
 *
 * NO BACKUP IS TAKEN HERE, DELIBERATELY. .github/workflows/oneoff.yml takes one
 * first on the apply path, through SQLite's online .backup API with an
 * integrity_check that aborts the run if it is not "ok".
 *
 * Run ON THE SERVER, against data/roots.db. Default is dry-run, and a dry run
 * opens the database READ-ONLY so it cannot write by accident.
 *
 *   node scripts/oneoff_link_replacement_TC000916.js          # dry run
 *   node scripts/oneoff_link_replacement_TC000916.js --apply  # write
 */
'use strict';

const path = require('path');
const fs = require('fs');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const Database = require(`${HOME}/node_modules/better-sqlite3`);
const dc = require(`${HOME}/lib/delay-case`);

const REPLACEMENT_NO = 'TC000916';
const ORIGINAL_NO = 'TC000902';
const WRITE = process.argv.includes('--apply');

const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath, WRITE ? {} : { readonly: true });

const J = (x) => JSON.stringify(x, null, 2);
const num = (x) => Math.round((Number(x) || 0) * 100) / 100;
const die = (m) => { console.error('\nREFUSED: ' + m + '\nNothing was written.'); process.exit(1); };
const rule = (t) => console.log('\n' + '─'.repeat(78) + '\n' + t);

console.log('db: ' + dbPath);
console.log('mode: ' + (WRITE ? 'APPLY — this will write' : 'DRY RUN — database opened read-only, nothing will be written'));

const getOrder = (no) => db.prepare('SELECT * FROM retail_orders WHERE order_no = ?').get(no);
const rep = getOrder(REPLACEMENT_NO);
const orig = getOrder(ORIGINAL_NO);
if (!rep)  die(`${REPLACEMENT_NO} was not found in ${dbPath}.`);
if (!orig) die(`${ORIGINAL_NO} was not found in ${dbPath}.`);

const show = (o) => ({
  id: o.id, order_no: o.order_no, status: o.status, customer_id: o.customer_id,
  placed_at: o.placed_at, subtotal: o.subtotal, total: o.total,
  channel: o.channel, source: o.source, staff_note: o.staff_note,
  replacement_for_order_id: o.replacement_for_order_id, replacement_case_id: o.replacement_case_id,
});
rule(`1 · the two orders, as they stand`);
console.log(`${REPLACEMENT_NO} (the replacement):\n` + J(show(rep)));
console.log(`${ORIGINAL_NO} (the original):\n` + J(show(orig)));

const repItems = db.prepare(
  'SELECT id, product_id, name_en, qty, unit_price, line_total FROM retail_order_items WHERE order_id = ? ORDER BY id').all(rep.id);
console.log(`${REPLACEMENT_NO} lines:\n` + J(repItems));

// ── Refuse unless it is what this was written for ───────────────────────────
rule('2 · checks');
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); return ok; };
let ok = true;
ok = check(num(rep.subtotal) === 0 && num(rep.total) === 0,
  `${REPLACEMENT_NO} is a no-charge order (subtotal ${rep.subtotal}, total ${rep.total})`) && ok;
ok = check(repItems.length > 0 && repItems.every((l) => num(l.unit_price) === 0 && num(l.line_total) === 0),
  `every ${REPLACEMENT_NO} line is ¥0`) && ok;
ok = check(rep.customer_id != null && rep.customer_id === orig.customer_id,
  `same customer on both (${rep.customer_id} / ${orig.customer_id})`) && ok;
ok = check(String(rep.placed_at || '') >= String(orig.placed_at || ''),
  `${REPLACEMENT_NO} was placed after ${ORIGINAL_NO}`) && ok;
ok = check(!orig.replacement_for_order_id, `${ORIGINAL_NO} is not itself a replacement`) && ok;
ok = check(rep.channel !== 'meituan' && rep.channel !== 'eleme',
  `${REPLACEMENT_NO} is not a platform-channel order (channel ${rep.channel})`) && ok;
if (!ok) die('one or more checks failed — the picture is not the one this script was written for. Look first.');

if (rep.replacement_for_order_id && rep.replacement_for_order_id !== orig.id) {
  die(`${REPLACEMENT_NO} is already linked to a DIFFERENT order (id ${rep.replacement_for_order_id}).`);
}
const alreadyLinked = rep.replacement_for_order_id === orig.id;

// ── The parcel and its case ─────────────────────────────────────────────────
rule(`3 · ${ORIGINAL_NO}'s parcels and case`);
const parcels = db.prepare('SELECT * FROM retail_shipments WHERE order_id = ? ORDER BY id').all(orig.id);
console.log(J(parcels.map((s) => ({
  id: s.id, mode: s.mode, dispatched_at: s.dispatched_at, delivered_at: s.delivered_at,
  tracking_status: s.tracking_status, late_days: dc.lateDays(s), delivered: dc.isDelivered(s),
  case: (dc.readCase(db, s.id) || null) && (({ id, reason, remedy, remedy_order_id, closed_at }) =>
    ({ id, reason, remedy, remedy_order_id, closed_at }))(dc.readCase(db, s.id)),
}))));

let casePlan;          // { sh, existing, open: 'damage'|'late'|null, answer: bool }
if (parcels.length !== 1) {
  casePlan = { skip: `${ORIGINAL_NO} has ${parcels.length} parcels; this script links the case only when there is exactly one, and will not guess which was the damaged one.` };
} else if (!dc.isDelivered(parcels[0])) {
  casePlan = { skip: `${ORIGINAL_NO}'s parcel has not been delivered, so it has no case to answer.` };
} else {
  const sh = parcels[0];
  const existing = dc.readCase(db, sh.id);
  if (existing && existing.closed_at) {
    casePlan = { skip: `the case on ${ORIGINAL_NO}'s parcel is already closed; reopen it from the drawer first if it should change.` };
  } else if (existing && existing.remedy && existing.remedy_order_id === rep.id) {
    casePlan = { sh, existing, done: true };
  } else if (existing && existing.remedy) {
    casePlan = { skip: `the case already answers step three as '${existing.remedy}'` +
      (existing.remedy_order_id ? ` (order id ${existing.remedy_order_id})` : '') + '; not overwriting it.' };
  } else {
    casePlan = { sh, existing, open: existing ? null : (dc.lateDays(sh) > 0 ? 'late' : 'damage') };
  }
}

rule('4 · the plan');
const steps = [];
if (alreadyLinked) console.log(`  · ${REPLACEMENT_NO} is already linked to ${ORIGINAL_NO} (replacement_for_order_id = ${orig.id}).`);
else { steps.push('link'); console.log(`  1. set ${REPLACEMENT_NO}.replacement_for_order_id = ${orig.id} (${ORIGINAL_NO})`); }
if (casePlan.skip) console.log(`  · case NOT touched — ${casePlan.skip}`);
else if (casePlan.done) console.log(`  · the case already says a replacement was sent as ${REPLACEMENT_NO}.`);
else {
  steps.push('case');
  if (casePlan.open) console.log(`  2. open a ${casePlan.open} case on parcel ${casePlan.sh.id}` +
    (casePlan.open === 'damage' ? ' (the parcel was on time, so it is a damage case)' : ' (the parcel was late)'));
  console.log(`  ${casePlan.open ? '3' : '2'}. answer step three as 'replacement' (note ${REPLACEMENT_NO}) and point the case at ${REPLACEMENT_NO}`);
  console.log(`  ${casePlan.open ? '4' : '3'}. set ${REPLACEMENT_NO}.replacement_case_id to that case`);
}
if (!steps.length) { console.log('\nNothing to do.'); process.exit(0); }
console.log('\n  Untouched: money, stock, customer-told, carrier claim, evidence, remedy_cost, source, channel.');

if (!WRITE) {
  console.log('\nDRY RUN — nothing was written. Re-run with apply=true once the plan above reads right.');
  process.exit(0);
}

// ── Write ───────────────────────────────────────────────────────────────────
const priorLog = db.prepare(
  `SELECT tenant_id FROM activity_log
    WHERE entity_type = 'retail_order' AND entity_id = ? ORDER BY id DESC LIMIT 1`
).get(orig.id);
const actor = { id: null, label: 'script' };
let caseId = null;
db.transaction(() => {
  if (steps.includes('case')) {
    const sh = casePlan.sh;
    let c = casePlan.existing;
    if (casePlan.open === 'damage') {
      const r = dc.reportDamage(db, { orderId: orig.id, shipment: sh, actor });
      if (r.error) throw new Error('could not open the damage case: ' + r.error);
      c = r.case;
    } else if (casePlan.open === 'late') {
      c = dc.ensureCase(db, orig.id, sh.id, actor);
    }
    dc.applyStep(db, { orderId: orig.id, shipmentId: sh.id, step: 'remedy',
      payload: { kind: 'replacement', note: REPLACEMENT_NO }, actor });
    db.prepare('UPDATE retail_delay_cases SET remedy_order_id = ? WHERE id = ?').run(rep.id, c.id);
    caseId = c.id;
  }
  const info = db.prepare(
    `UPDATE retail_orders
        SET replacement_for_order_id = COALESCE(replacement_for_order_id, ?),
            replacement_case_id      = COALESCE(?, replacement_case_id),
            updated_at               = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(orig.id, caseId, rep.id);
  if (info.changes !== 1) throw new Error('expected to update exactly one order, updated ' + info.changes);
  db.prepare(
    `INSERT INTO activity_log (user_id, username, action, entity_type, entity_id, details, tenant_id)
     VALUES (NULL, 'script', 'replacement_linked', 'retail_order', ?, ?, ?)`
  ).run(rep.id, JSON.stringify({
    replacement: REPLACEMENT_NO, original: ORIGINAL_NO, original_id: orig.id,
    case_id: caseId, steps,
    reason: 'raised by hand as a no-charge order; linked so it stops counting as trade and TC000902 shows the replacement',
    script: 'scripts/oneoff_link_replacement_TC000916.js',
    untouched: ['money', 'stock', 'customer-told', 'carrier claim', 'evidence', 'remedy_cost', 'source', 'channel'],
  }), priorLog ? priorLog.tenant_id : null);
})();

console.log('\nAFTER:');
console.log(J(show(getOrder(REPLACEMENT_NO))));
if (caseId) console.log('case:\n' + J(dc.forScreen(db, db.prepare('SELECT * FROM retail_delay_cases WHERE id = ?').get(caseId))));
