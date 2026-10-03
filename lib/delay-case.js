// The late-parcel case — the rule about what may be closed, and when (§98).
//
// A parcel arrived late, the fresh items in it spoiled, and putting that right
// takes four things: tell the customer, claim off the carrier, make the customer
// whole, and record what the carrier finally paid. The middle one runs for
// weeks. Before this file the whole situation had ONE stamp
// (`retail_shipments.air_delay_cleared_at`) and the drawer printed TWO
// instructions over it, so "I phoned the customer" and "the carrier settled"
// were the same fact and neither could be told from the other.
//
// ── THIS IS A FILE, NOT A ROUTE, FOR ONE REASON ────────────────────────────
// So a test can run the close rule against an in-memory database instead of
// booting the app — the lesson `lib/expense-claim.js` records in its own header
// and `lib/expense-posting.js` was split out to honour. Every function here
// takes a better-sqlite3-shaped handle: the tenant handle in production, a
// fixture in a test. Nothing here reaches for a request, a user or a global.
//
// ── WHAT THE RULE IS ───────────────────────────────────────────────────────
// A case closes when every track that applies has reached a state it cannot
// move out of, AND A DISPUTE STILL SITTING WITH THE CARRIER IS NEVER ONE OF
// THOSE STATES. That last clause is the whole feature. Everything else here is
// bookkeeping around it.
//
// `none` is deliberately NOT terminal. An operator who never touches the
// dispute track leaves the case open, which is correct — not deciding is not
// the same as deciding not to claim. Deciding not to claim is `no_claim`, it
// needs a reason typed, and it finishes the track in one tap. That is the "if
// any" in "the dispute with the logistics company, if any": on a ¥40 spoil
// nobody files anything, and the case must still be closeable.
//
// ── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
// It does not post to the ledger. `dispute_received` is RECORDED here and
// reaches `income_entries` in §98's fourth stage, by `postClaim`'s
// delete-then-reinsert shape, and not before: §87's rule is that a claim is not
// in the books because it was filed, and money in obeys it exactly as money out
// does. It also does not raise the ¥0 replacement order — stage three — so
// `remedy` is an operator's tick over an order they made by hand.

'use strict';

const money = require('./money');
const { carrierByCode } = require('./tracking');
const { JD_PRODUCT_MODE } = require('./jd');

// ── WHEN A PARCEL IS LATE ENOUGH TO RAISE A CASE ───────────────────────────
// Days after dispatch, per delivery mode. A parcel delivered later than its
// mode's figure raises the case; a mode absent from this map never raises one.
//
// UNTIL 2026-09-11 THIS WAS `mode = 'air'` AND ONE HARD-CODED `+1 day`, WRITTEN
// OUT FOUR TIMES IN routes/retail.js AND TWICE MORE ON THE TWO CLIENTS. That is
// the same drift the paid-status predicate had, found the same way, and it is
// consolidated here for the same reason.
//
// AIR-ONLY WAS A REAL HOLE, NOT A CONSERVATIVE DEFAULT. `planShipments` sends
// EVERY Guangdong order by land — "the province ships by ground regardless of
// any item's air flag, so a single land shipment carries everything (an 'Air
// only' product still goes by land within Guangdong)". So the province closest
// to the kitchen, carrying ice-pack goods, was the one destination whose late
// parcels raised nothing at all.
//
// THE FIGURES, AND WHY EACH IS WHAT IT IS:
//   air   1 — unchanged. This is the live rule and widening must not restate
//             any case that already exists.
//   local 1 — same-city rider against a same-day promise. A day past that is
//             not a slow day, it is a failure.
//   land  3 — ground freight is legitimately slower, inside Guangdong and out.
//             Set at 1 it would fire on ordinary two-day deliveries and the
//             badge would be noise within a week, which is how an alert stops
//             being read.
//
// FIXED IN THIS PHASE AND NOT TENANT-EDITABLE, deliberately, exactly as §32
// fixed the waste reason codes: a number somebody can change is a settings
// screen, a migration and a per-tenant default, and none of that is worth
// building before anyone has run the alert for a month and said it is wrong.
// Changing it is editing this map.
const LATE_AFTER_DAYS = Object.freeze({ air: 1, local: 1, land: 3 });

/**
 * SQL naming the moment a parcel counts as late, per its own mode.
 *
 * Modes absent from LATE_AFTER_DAYS produce NULL here, and every comparison
 * against NULL is false — so a supplier-direct parcel, which is not ours to
 * claim against, never raises a case without needing to be named.
 */
function lateAfterSql(alias) {
  const q = alias ? alias + '.' : '';
  const whens = Object.entries(LATE_AFTER_DAYS)
    .map(([m, d]) => `WHEN '${m}' THEN '+${d} day'`).join(' ');
  return `DATE(${q}dispatched_at, CASE ${bookedModeSql(alias)} ${whens} ELSE NULL END)`;
}

// ── §421 · THE CARRIER IS HELD TO WHAT IT WAS PAID FOR ─────────────────────
// Reported by Ash 2026-10-03 against TC000899: "order eventually shipped by
// land but the dispute because of delay was calculated according to air."
//
// The parcel's `mode` is what the PLAN chose, and §381 deliberately never
// rewrites it: an air parcel booked on 生鲜标快 is still an 'air' parcel to
// packing and planning. But this file asks a different question — was the
// CARRIER late? — and JD can only be late against the service it was booked
// on. Reading `mode` here gave a ground waybill air's one day, raised a case on
// day two, and walked staff into filing a claim JD would rightly reject. Every
// Fujian / Guangxi air parcel (ground by default, jd.isLandDefaultProvince)
// had the same hole.
//
// SO THE DEADLINE FOLLOWS THE BOOKED SERVICE WHEN THERE IS ONE, both ways: a
// ground product gets land's figure, an air product air's. With no JD booking
// on record — another carrier, a pasted number, a local rider — `mode` stands,
// exactly as before.
//
// THE PRODUCT COUNTS ONLY FOR THE WAYBILL IT WAS BOOKED FOR. It is stored with
// the number (waybill_product_no), and honoured only while that is still the
// parcel's tracking_number. A cancelled label, or a number pasted over it by
// any of the routes that write tracking_number, falls back to `mode` on its own
// — without every one of those writers having to remember to clear it.

/** The mode the late rule judges a parcel by: its booked service, else its plan. */
function bookedMode(s) {
  if (!s) return undefined;
  if (s.waybill_product && s.waybill_product_no && s.waybill_product_no === s.tracking_number) {
    const m = JD_PRODUCT_MODE[s.waybill_product];
    if (m) return m;
  }
  return s.mode;
}

/** bookedMode, as SQL. */
function bookedModeSql(alias) {
  const q = alias ? alias + '.' : '';
  const whens = Object.entries(JD_PRODUCT_MODE)
    .map(([p, m]) => `WHEN '${p}' THEN '${m}'`).join(' ');
  return `(CASE WHEN ${q}waybill_product_no = ${q}tracking_number
                THEN CASE ${q}waybill_product ${whens} ELSE ${q}mode END
                ELSE ${q}mode END)`;
}

// ── THE DAY THIS FEATURE STARTS ────────────────────────────────────────────
// Parcels delivered before this date never raise a case. Decided by Ash on
// 2026-09-11 — "no need to raise a case for previous orders, only from today" —
// after widening the alert from air-only lit up the whole history at once.
//
// WIDENING A LIVE ALERT IS RETROACTIVE UNLESS YOU STOP IT, and that is the
// lesson worth keeping. The rule changed from `mode='air'` to every mode, and
// the query behind the dashboard card does not care when the rule changed: it
// asked the same question of every parcel ever shipped and correctly answered
// that dozens of them were late. The oldest was seventy-nine days old. Nobody
// is going to ring a customer about food from seventy-nine days ago, so every
// one of those rows was work that would never be done, on the one card whose
// whole job is to list work that will be.
//
// A FIXED DATE, NOT A ROLLING WINDOW. A window of "the last N days" would have
// answered the same complaint and quietly re-raised history every time somebody
// changed N; a cutover says plainly that the feature began on a day, which is
// what actually happened.
//
// THE ESCAPE HATCH IS DELIBERATE. A parcel with a case row already against it
// stays in scope however old it is — otherwise a dispute somebody had already
// started would vanish from the card mid-chase, which is the exact failure §98
// exists to prevent. Only parcels nobody has ever touched are filtered out.
const CASES_FROM = '2026-09-11';

/**
 * The whole "this parcel is late" predicate: dispatched, delivered, delivered
 * after its mode's allowance, and not from before the feature existed.
 * One definition, four former copies.
 */
function lateShipmentSql(alias) {
  const q = alias ? alias + '.' : '';
  const when = `DATE(COALESCE(${q}delivered_at, ${q}tracking_synced_at))`;
  return `${q}dispatched_at IS NOT NULL
       AND (${q}delivered_at IS NOT NULL OR ${q}tracking_status = 'delivered')
       AND ${when} > ${lateAfterSql(alias)}
       AND (${when} >= '${CASES_FROM}'
            OR EXISTS (SELECT 1 FROM retail_delay_cases dc WHERE dc.shipment_id = ${q}id))`;
}

/**
 * How many days late a parcel is, or 0. The SERVER computes this and both
 * screens render it — before 2026-09-11 each client did its own date
 * arithmetic against its own copy of the one-day rule, which is two more
 * places for the threshold to drift from this file.
 */
function lateDays(s) {
  if (!s) return 0;
  const allowed = LATE_AFTER_DAYS[bookedMode(s)];
  if (!allowed) return 0;
  // LANDED, mirrored from the query's second line. Without it a parcel still on
  // the road read tracking_synced_at — the last sync, not a delivery — as its
  // delivery day, so the drawer drew the checklist for a parcel the query does
  // not count. Its 'Mark handled' then cleared nothing, said "Marked handled",
  // and left the panel up. Reported from the phone against TC000899, out for
  // delivery. Before landing it is §285's "running late", not this.
  if (!s.delivered_at && s.tracking_status !== 'delivered') return 0;
  // The cutover, mirrored. Without it the drawer would draw a checklist for a
  // parcel the dashboard and the list have both filtered out — one screen
  // saying there is work and two saying there is none.
  const when = String(s.delivered_at || s.tracking_synced_at || '').slice(0, 10);
  if (when && when < CASES_FROM && !s.delay_case) return 0;
  const dispatched = String(s.dispatched_at || '').slice(0, 10);
  const delivered = String(s.delivered_at || s.tracking_synced_at || '').slice(0, 10);
  if (!dispatched || !delivered) return 0;
  if (dispatched === '0000-00-00' || delivered === '0000-00-00') return 0;
  const due = new Date(dispatched + 'T00:00:00Z');
  due.setUTCDate(due.getUTCDate() + allowed);
  const deliveredAt = new Date(delivered + 'T00:00:00Z');
  if (!(deliveredAt > due)) return 0;
  return Math.round((deliveredAt - due) / 86400000);
}

// ── §285 · RUNNING LATE — THE SAME DEADLINE, ASKED BEFORE DELIVERY ─────────
// Reported by Ash 2026-09-27: "delay order should be noticible to us not when
// the delivery already reach the customer, we should know it before."
//
// Everything above asks "did it ARRIVE late?", which can only be answered once
// it has arrived — so the card lit up when the customer already had the box.
// This asks the same question of a parcel that has NOT arrived: has the day it
// was due come and gone? Same LATE_AFTER_DAYS, same UTC day arithmetic as
// lateShipmentSql, so a parcel that is "running late" today and lands tomorrow
// is exactly the parcel the late case then opens on — the two can never
// disagree about where the line is.
//
// WHAT IT DELIBERATELY DOES NOT DO: open a case, message the customer, or
// touch air_delay_cleared_at. Those belong to a parcel that has landed. This is
// only an early warning to the shop; it clears itself on delivery, and if the
// delivery was late the §98 case takes over from there.
//
// ITS OWN CUTOVER, for the reason CASES_FROM gives: turned on against every
// parcel ever marked dispatched and never marked delivered, it would surface
// weeks-old rows nobody is going to chase. A parcel whose deadline passed
// before this day is out of scope.
const RUNNING_LATE_FROM = '2026-09-26';

/**
 * A parcel that has left, has not landed, and whose deadline day has passed.
 * `now` is a SQL expression for "today", overridable so a test can pin it.
 */
function runningLateSql(alias, today = "DATE('now')") {
  const q = alias ? alias + '.' : '';
  return `${q}dispatched_at IS NOT NULL
       AND ${q}delivered_at IS NULL
       AND COALESCE(${q}tracking_status, '') <> 'delivered'
       AND ${today} > ${lateAfterSql(alias)}
       AND ${lateAfterSql(alias)} >= '${RUNNING_LATE_FROM}'`;
}

/**
 * The instant a parcel starts running late: the start of the first day after
 * its due day (UTC). What the Needs-you row ages from.
 */
function runningLateSinceSql(alias) {
  return `datetime(${lateAfterSql(alias)}, '+1 day')`;
}

/**
 * How many days past its deadline a parcel that has NOT landed is, or 0. The
 * mirror of runningLateSql, the way lateDays mirrors lateShipmentSql.
 */
function runningLateDays(s, now = new Date()) {
  if (!s) return 0;
  const allowed = LATE_AFTER_DAYS[bookedMode(s)];
  if (!allowed) return 0;
  if (s.delivered_at || s.tracking_status === 'delivered') return 0;
  const dispatched = String(s.dispatched_at || '').slice(0, 10);
  if (!dispatched || dispatched === '0000-00-00') return 0;
  const due = new Date(dispatched + 'T00:00:00Z');
  if (isNaN(due.getTime())) return 0;
  due.setUTCDate(due.getUTCDate() + allowed);
  if (due.toISOString().slice(0, 10) < RUNNING_LATE_FROM) return 0;
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  if (!(today > due)) return 0;
  return Math.round((today - due) / 86400000);
}

/** Dispute states that finish the track. `none` and `filed` are not here. */
const DISPUTE_TERMINAL = Object.freeze(['paid', 'rejected', 'withdrawn', 'no_claim']);
/** Every state the column may hold. */
const DISPUTE_STATES = Object.freeze(['none', 'filed', ...DISPUTE_TERMINAL]);
/** How a carrier's answer can land, once one arrives. */
const SETTLE_OUTCOMES = Object.freeze(['paid', 'rejected', 'withdrawn']);
/**
 * How the make-whole track can finish. A branch, taken once.
 *
 * §125 ADDED THE THIRD ANSWER, AND IT IS THE ONE THE SCREEN HAD NO WAY TO SAY:
 * the parcel was late, the customer opened it, and the food was fine. Nothing
 * is owed. The case is still real — the carrier was still late and may still
 * owe us — but no goods go back out and no money goes back.
 *
 * Until it existed the operator had three exits and every one of them was
 * wrong: raise a no-charge replacement order nobody wanted, tick a refund that
 * never happened, or leave the step alone and hold `customer_not_made_whole`
 * on the case for good. The third is what actually happened, which is how a
 * closed matter ends up sitting on the alert card forever.
 *
 * `none` TAKES A TYPED REASON, for the reason `no_claim` does: "nothing was
 * owed" read back in six months with nothing beside it cannot be told from a
 * mis-tap, and the two other answers evidence themselves — there is a
 * replacement order or a refund behind each of them.
 */
const REMEDIES = Object.freeze(['replacement', 'refund', 'none']);

/** Every step a route may apply. Anything else is refused by name. */
const STEPS = Object.freeze([
  'customer_told', 'claim_filed', 'no_claim', 'settled', 'remedy', 'note',
]);

/** True while the carrier still owes us an answer. */
function disputeIsOpen(c) {
  return !DISPUTE_TERMINAL.includes(String(c && c.dispute_state || 'none'));
}

/**
 * Why this case cannot be closed yet — an array of codes, empty when it can.
 *
 * CODES, NOT SENTENCES. The two surfaces that render this (the desktop drawer
 * and the phone) each carry their own bilingual strings, exactly as every other
 * refusal in this product does; a sentence built here would be a third place
 * the wording lives and the first to go stale.
 */
function blockers(c) {
  const out = [];
  if (!c) return ['no_case'];
  if (!c.customer_told_at) out.push('customer_not_told');
  // ANY of the three REMEDIES clears this, `none` included — the question is
  // whether the make-whole track was ANSWERED, not whether something was given.
  if (!c.remedy)           out.push('customer_not_made_whole');
  if (disputeIsOpen(c))    out.push('dispute_open');
  return out;
}

/** Shorthand for `blockers(c).length === 0`. */
function canClose(c) {
  return blockers(c).length === 0;
}

/** Round to the two decimals every ¥ column in this schema holds, or null. */
function amount(v) {
  if (v === null || v === undefined || v === '') return null;
  const minor = money.toMinor(v);
  if (minor === null || minor === undefined) return null;
  return money.fromMinor(minor);
}

function readCase(db, shipmentId) {
  return db.prepare('SELECT * FROM retail_delay_cases WHERE shipment_id = ?')
           .get(shipmentId) || null;
}

function readCaseByOrder(db, orderId) {
  return db.prepare(
    'SELECT * FROM retail_delay_cases WHERE order_id = ? ORDER BY id LIMIT 1'
  ).get(orderId) || null;
}

function logEvent(db, caseId, event, { note, amount: amt, actor, meta } = {}) {
  db.prepare(
    `INSERT INTO retail_delay_case_events
       (case_id, event, note, amount, user_id, user_label, meta_json)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    caseId, event, note || null, amt === undefined ? null : amt,
    actor && actor.id ? actor.id : null,
    actor && actor.label ? actor.label : null,
    meta ? JSON.stringify(meta) : null,
  );
}

/**
 * The case for this parcel, creating it if this is the first anyone has looked.
 *
 * CREATED LAZILY, ON PURPOSE. The thing that decides a parcel is late is a
 * QUERY (`orderHasDelayedAirShipment` and the three copies of its predicate),
 * not an event — there is no sweep, and orders already delivered late in
 * production have no case and never will have one written for them by a
 * migration. So the row appears the first time the situation is looked at or
 * acted on, which is the same shape `ensureShipments` has used on this path
 * since it was written.
 */
function ensureCase(db, orderId, shipmentId, actor) {
  const found = readCase(db, shipmentId);
  if (found) return found;
  const info = db.prepare(
    'INSERT INTO retail_delay_cases (order_id, shipment_id) VALUES (?,?)'
  ).run(orderId, shipmentId);
  logEvent(db, info.lastInsertRowid, 'opened', { actor });
  return readCase(db, shipmentId);
}

/**
 * Apply one step and log it. Returns the case as it now stands.
 *
 * RE-APPLYING A STEP IS ALLOWED and writes a second event rather than being
 * refused. An operator who typed the wrong claim number types it again; the
 * columns say where the case stands now and the events say how it got there,
 * which is the division `retail_refund_events` already draws. A refusal here
 * would send them to a database to fix a typo.
 *
 * Throws an Error whose `.code` a route turns into a 400. The codes are the
 * vocabulary the two screens answer with.
 */
function applyStep(db, { orderId, shipmentId, step, payload = {}, actor }) {
  if (!STEPS.includes(step)) { const e = new Error('unknown step'); e.code = 'unknown_step'; throw e; }
  const c = ensureCase(db, orderId, shipmentId, actor);
  if (c.closed_at) { const e = new Error('case is closed'); e.code = 'case_closed'; throw e; }

  const set = (sql, ...args) =>
    db.prepare(`UPDATE retail_delay_cases SET ${sql} WHERE id = ?`).run(...args, c.id);

  if (step === 'customer_told') {
    set('customer_told_at = CURRENT_TIMESTAMP, customer_told_by = ?',
        actor && actor.label ? actor.label : null);
    logEvent(db, c.id, 'customer_told', { note: payload.note || null, actor });

  } else if (step === 'claim_filed') {
    // The carrier is whatever this parcel actually went with. NOTHING HERE MAY
    // NAME ONE: the banner being replaced hard-codes 京东 and that is the line
    // §98 refuses to carry forward — `lib/tracking.js` already holds the list,
    // `other` included, and other tenants ship with other carriers.
    const carrier = String(payload.carrier || '').trim() || null;
    if (carrier && !carrierByCode(carrier)) {
      const e = new Error('unknown carrier'); e.code = 'unknown_carrier'; throw e;
    }
    const claimed = amount(payload.claimed);
    if (payload.claimed !== undefined && payload.claimed !== '' && claimed === null) {
      const e = new Error('bad amount'); e.code = 'bad_amount'; throw e;
    }
    set(`dispute_state = 'filed', dispute_carrier = ?, dispute_ref = ?,
         dispute_claimed = ?, dispute_filed_at = COALESCE(dispute_filed_at, CURRENT_TIMESTAMP),
         dispute_settled_at = NULL, dispute_received = NULL`,
        carrier, String(payload.ref || '').trim() || null, claimed);
    logEvent(db, c.id, 'claim_filed', {
      note: payload.note || null, amount: claimed, actor,
      meta: carrier || payload.ref ? { carrier, ref: payload.ref || null } : null,
    });

  } else if (step === 'no_claim') {
    // A REASON IS REQUIRED, and this is the one place in the file that demands
    // typing. "We are not claiming" read back in six months with nothing beside
    // it cannot be told from "nobody got round to it", which is the exact
    // confusion the whole case exists to remove.
    const note = String(payload.note || '').trim();
    if (!note) { const e = new Error('reason required'); e.code = 'reason_required'; throw e; }
    set(`dispute_state = 'no_claim', dispute_note = ?,
         dispute_settled_at = CURRENT_TIMESTAMP`, note);
    logEvent(db, c.id, 'no_claim', { note, actor });

  } else if (step === 'settled') {
    const outcome = String(payload.outcome || '').trim();
    if (!SETTLE_OUTCOMES.includes(outcome)) {
      const e = new Error('bad outcome'); e.code = 'bad_outcome'; throw e;
    }
    const received = outcome === 'paid' ? amount(payload.received) : null;
    if (outcome === 'paid' && received === null) {
      const e = new Error('amount required'); e.code = 'amount_required'; throw e;
    }
    // WHO RECORDED IT is stamped here because §98 stage four posts the ledger
    // row off this case, and §92's rule is that a ledger row names the person
    // who put it in the books.
    set(`dispute_state = ?, dispute_received = ?, dispute_note = ?,
         dispute_settled_at = CURRENT_TIMESTAMP,
         settled_by_user_id = ?, settled_by = ?`,
        outcome, received, String(payload.note || '').trim() || null,
        actor && actor.id ? actor.id : null,
        actor && actor.label ? actor.label : null);
    logEvent(db, c.id, 'settled', { note: payload.note || null, amount: received, actor,
                                    meta: { outcome } });

  } else if (step === 'remedy') {
    const kind = String(payload.kind || '').trim();
    if (!REMEDIES.includes(kind)) { const e = new Error('bad remedy'); e.code = 'bad_remedy'; throw e; }
    const rnote = String(payload.note || '').trim();
    // The reason is required on `none` ONLY. See REMEDIES above for why: it is
    // the one answer that finishes the track by doing nothing, so it is also
    // the one that leaves nothing behind to read.
    if (kind === 'none' && !rnote) {
      const e = new Error('reason required'); e.code = 'reason_required'; throw e;
    }
    set(`remedy = ?, remedy_at = CURRENT_TIMESTAMP, remedy_note = ?`, kind, rnote || null);
    logEvent(db, c.id, kind === 'refund'      ? 'remedy_refund'
                     : kind === 'none'        ? 'remedy_none'
                                              : 'remedy_replacement',
             { note: payload.note || null, actor });

  } else if (step === 'note') {
    const note = String(payload.note || '').trim();
    if (!note) { const e = new Error('reason required'); e.code = 'reason_required'; throw e; }
    logEvent(db, c.id, 'note', { note, actor });
  }

  return readCase(db, shipmentId);
}

/**
 * Close the case, or refuse and say why.
 *
 * THE REFUSAL IS THE FEATURE. The route that calls this is the same one that
 * has always stamped `air_delay_cleared_at` from a single button meaning "I
 * contacted the customer"; it keeps stamping it, and it now cannot while the
 * carrier still owes us an answer.
 */
function closeCase(db, { orderId, shipmentId, actor }) {
  const c = ensureCase(db, orderId, shipmentId, actor);
  if (c.closed_at) return { ok: true, case: c, blockers: [] };
  const why = blockers(c);
  if (why.length) return { ok: false, case: c, blockers: why };
  db.prepare(
    `UPDATE retail_delay_cases
        SET closed_at = CURRENT_TIMESTAMP, closed_by = ?
      WHERE id = ?`
  ).run(actor && actor.label ? actor.label : null, c.id);
  logEvent(db, c.id, 'closed', { actor });
  return { ok: true, case: readCase(db, shipmentId), blockers: [] };
}

/** Undo a close. The existing alert already had an undo and keeps it. */
function reopenCase(db, { orderId, shipmentId, actor }) {
  const c = ensureCase(db, orderId, shipmentId, actor);
  if (!c.closed_at) return c;
  db.prepare(
    'UPDATE retail_delay_cases SET closed_at = NULL, closed_by = NULL WHERE id = ?'
  ).run(c.id);
  logEvent(db, c.id, 'reopened', { actor });
  return readCase(db, shipmentId);
}

/**
 * The evidence attached to a case — METADATA ONLY, never the bytes.
 *
 * Selecting `data` here would put every photograph on the case into the order
 * detail payload, and from there into an orders list that draws several. The
 * picture has its own route, exactly as a staff claim's receipt does.
 */
function caseFiles(db, caseId) {
  return db.prepare(
    `SELECT id, label, bytes, uploaded_by_label, created_at
       FROM retail_delay_case_files WHERE case_id = ? ORDER BY id`
  ).all(caseId);
}

/** Attach one file. Returns its id. */
function addCaseFile(db, caseId, { data, label, actor } = {}) {
  const uri = String(data || '');
  // A DATA URI FOR AN IMAGE, and nothing else. Without this the column takes
  // any string a caller sends and the two screens render it into an <img src>.
  if (!/^data:image\/(png|jpe?g|gif|webp|heic|heif);base64,/i.test(uri)) {
    const e = new Error('not an image'); e.code = 'bad_image'; throw e;
  }
  const info = db.prepare(
    `INSERT INTO retail_delay_case_files (case_id, label, data, bytes, uploaded_by, uploaded_by_label)
     VALUES (?,?,?,?,?,?)`
  ).run(caseId, String(label || '').trim() || null, uri, uri.length,
        actor && actor.id ? actor.id : null,
        actor && actor.label ? actor.label : null);
  return info.lastInsertRowid;
}

/** One file's bytes, by id, scoped to its case so an id alone opens nothing. */
function caseFileData(db, caseId, fileId) {
  return db.prepare(
    'SELECT data FROM retail_delay_case_files WHERE id = ? AND case_id = ?'
  ).get(fileId, caseId) || null;
}

/** Detach one file. Scoped to its case for the same reason. */
function removeCaseFile(db, caseId, fileId) {
  return db.prepare(
    'DELETE FROM retail_delay_case_files WHERE id = ? AND case_id = ?'
  ).run(fileId, caseId).changes > 0;
}

/** The events behind one case, oldest first — the timeline the drawer draws. */
function caseEvents(db, caseId) {
  return db.prepare(
    'SELECT * FROM retail_delay_case_events WHERE case_id = ? ORDER BY id'
  ).all(caseId);
}

/**
 * WHICH GOODS GO BACK OUT, AND HOW MANY OF EACH (§98 addendum 8).
 *
 * The replacement used to be the whole parcel, always. That is right when the
 * whole parcel spoiled and wrong every other time: a six-product box with two
 * spoiled salads sent six products back out, and four of them left the shelf
 * for nothing. Ash reported it against TC000750 — *"maybe the replacement is
 * only for few items?"* — and it is the same shape as §174's kitchen box,
 * where a line can be refused rather than the order.
 *
 * `requested` ABSENT MEANS EVERY LINE AT FULL QUANTITY, deliberately: that is
 * what this route did before, and a client that has not been reloaded since
 * the deploy must keep working rather than start refusing.
 *
 * Returns `{ error }` or `{ picked: [{ line, qty }] }`. The caller copies the
 * lines; nothing here writes.
 */
function resolveReplacementLines(lines, requested) {
  const all = Array.isArray(lines) ? lines : [];
  if (!all.length) return { error: 'no_items' };
  if (requested == null) {
    return { picked: all.map(l => ({ line: l, qty: Number(l.qty) || 0 })).filter(p => p.qty > 0) };
  }
  if (!Array.isArray(requested)) return { error: 'bad_items' };
  const byId = new Map(all.map(l => [Number(l.id), l]));
  const seen = new Set();
  const picked = [];
  for (const r of requested) {
    const id = parseInt(r && (r.item_id ?? r.id), 10);
    const line = byId.get(id);
    // A line from another order, or from a parcel that is not the late one, is
    // refused rather than ignored — a typo that silently sends nothing is the
    // worse failure of the two.
    if (!Number.isInteger(id) || !line) return { error: 'bad_item' };
    if (seen.has(id)) return { error: 'duplicate_item' };
    seen.add(id);
    const want = parseInt(r.qty, 10);
    if (!Number.isInteger(want) || want < 0) return { error: 'bad_qty' };
    if (want === 0) continue;                       // not going back out
    // NEVER MORE THAN WENT OUT. A replacement is goods being re-sent, so the
    // original line is the ceiling; more than that is a new order somebody
    // should raise on purpose.
    if (want > (Number(line.qty) || 0)) return { error: 'qty_too_high' };
    picked.push({ line, qty: want });
  }
  if (!picked.length) return { error: 'no_items' };
  return { picked };
}

/**
 * WHAT PUTTING IT RIGHT COST US — goods plus the freight to send them.
 *
 * The goods half is best-effort per line, as it has been since stage three: a
 * product with no cost on file contributes nothing rather than blocking the
 * replacement. The freight half is TYPED BY THE OPERATOR, for the same reason
 * §98 types the claim amounts — every carrier prices a parcel differently and
 * a rate engine here would serve one tenant.
 *
 * Returns null when nothing could be costed at all, which is what keeps the
 * screen's `cost` bit off rather than printing a ¥0 that reads as free.
 */
function replacementCost(picked, unitCostFor, shippingCost) {
  let goods = 0;
  let costed = false;
  for (const p of (picked || [])) {
    let unit = 0;
    try { unit = p.line && p.line.product_id ? Number(unitCostFor(p.line.product_id)) || 0 : 0; }
    catch (e) { unit = 0; }                          // uncosted line — see above
    if (unit > 0) { goods += unit * (Number(p.qty) || 0); costed = true; }
  }
  // Each half rounds to the fen BEFORE they are added, so the total on screen
  // is always the two figures beside it added up — a total rounded from raw
  // floats can land a fen away from its own breakdown.
  const ship = Math.round((Number(shippingCost) || 0) * 100) / 100;
  goods = Math.round(goods * 100) / 100;
  if (!costed && ship <= 0) return { goods: null, shipping: null, total: null };
  return { goods, shipping: ship > 0 ? ship : null,
           total: Math.round((goods + ship) * 100) / 100 };
}

/**
 * What the two screens render. One shape, so the desktop drawer and the phone
 * cannot drift into disagreeing about which step is outstanding.
 */
function forScreen(db, c) {
  if (!c) return null;
  return {
    id:               c.id,
    order_id:         c.order_id,
    shipment_id:      c.shipment_id,
    closed_at:        c.closed_at || null,
    closed_by:        c.closed_by || null,
    customer_told_at: c.customer_told_at || null,
    customer_told_by: c.customer_told_by || null,
    dispute_state:    c.dispute_state || 'none',
    dispute_carrier:  c.dispute_carrier || null,
    dispute_ref:      c.dispute_ref || null,
    dispute_claimed:  c.dispute_claimed === null ? null : c.dispute_claimed,
    dispute_received: c.dispute_received === null ? null : c.dispute_received,
    dispute_filed_at: c.dispute_filed_at || null,
    dispute_note:     c.dispute_note || null,
    remedy:           c.remedy || null,
    remedy_at:        c.remedy_at || null,
    remedy_note:      c.remedy_note || null,
    remedy_order_id:  c.remedy_order_id || null,
    // WHAT PUTTING IT RIGHT COST US. The replacement order's own lines are ¥0,
    // so this is the only figure that can be set against what the carrier paid
    // — which is the one question the whole case exists to answer.
    remedy_cost:      c.remedy_cost === null || c.remedy_cost === undefined ? null : c.remedy_cost,
    // The freight half of that figure, kept apart so the screen can say what
    // the total is made of. `remedy_cost` is the TOTAL and always has been —
    // a reader that ignores this column still reads the right number.
    remedy_shipping_cost:
      c.remedy_shipping_cost === null || c.remedy_shipping_cost === undefined
        ? null : c.remedy_shipping_cost,
    opened_at:        c.opened_at || null,
    dispute_open:     disputeIsOpen(c),
    blockers:         blockers(c),
    can_close:        canClose(c),
    events:           db ? caseEvents(db, c.id) : [],
    // Metadata only — the pictures are fetched one at a time by their own route.
    files:            db ? caseFiles(db, c.id) : [],
  };
}

module.exports = {
  LATE_AFTER_DAYS, CASES_FROM, lateAfterSql, lateShipmentSql, lateDays,
  bookedMode, bookedModeSql,
  RUNNING_LATE_FROM, runningLateSql, runningLateSinceSql, runningLateDays,
  DISPUTE_STATES, DISPUTE_TERMINAL, SETTLE_OUTCOMES, REMEDIES, STEPS,
  disputeIsOpen, blockers, canClose,
  ensureCase, readCase, readCaseByOrder, applyStep, closeCase, reopenCase,
  resolveReplacementLines, replacementCost,
  caseEvents, caseFiles, addCaseFile, caseFileData, removeCaseFile, forScreen,
};
