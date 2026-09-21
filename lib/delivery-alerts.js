// "Delivery needs a call" — the one definition of which orders are in it.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// The dashboard card counts FOUR kinds of delivery trouble (a carrier that
// reported a problem, a cold-chain parcel that landed late, a Meituan order
// well past its promised time, and one of our own riders who never picked up).
// The card's number came from four queries written inline in the ops route;
// the ORDERS LIST it opens onto filtered on `status=delayed`, which tested
// exactly ONE of the four. So a card reading 3 could open a list of none, and
// a card reading 1 — the case Ash reported off the live phone on 2026-09-14 —
// could open a list showing nothing at all.
//
// That is the same class of drift §98 was raised to fix, one level down: §98
// noticed the card sent people to the WRONG SCREEN and gave the filter a name,
// but the name only ever meant a quarter of what the card was counting. Both
// halves read this file now, so the number on the card and the length of the
// list are one fact rather than two queries that have to agree.
//
// ── A FILE, NOT A ROUTE ────────────────────────────────────────────────────
// Same reason lib/delay-case.js gives in its own header: a test can run these
// predicates against an in-memory database without booting the app. Every
// function here takes a better-sqlite3-shaped handle — the tenant handle in
// production, a fixture in a test — and nothing reaches for a request, a user
// or a global.
//
// ── WHY ONE OF THE FOUR IS NOT SQL ─────────────────────────────────────────
// Three of the four are plain predicates and compose into a WHERE. The fourth
// — our own rider, stuck before pickup — cannot be, because a local ETA is
// stored as a bare "HH:MM" that only means anything once it is resolved
// against TODAY in the shop's wall-clock, and the scheduled-for check needs
// the same resolution. That arithmetic lives in JavaScript (it always has),
// so this file runs it and hands back order ids to be matched by id. It is a
// small set by construction: a live rider job touched in the last half hour.

'use strict';

const delayCase = require('./delay-case');

/**
 * A carrier reported a PROBLEM an operator should chase: the courier cannot
 * reach the customer (no_contact), a generic delivery exception, or the parcel
 * is on its way back. Carrier-reported states only — no time-based "stalled"
 * guessing. Pickup-point / locker drop-offs are NOT problems and are excluded.
 *
 * Dispatched only: a delivered or cancelled order's stale flags are history,
 * not a live alert.
 */
function carrierAlertSql(alias = 'o') {
  const q = alias + '.';
  return `${q}status = 'dispatched'
         AND ( ${q}tracking_status IN ('exception','returning','returned')
            OR ${q}tracking_scenario = 'no_contact' )`;
}

/**
 * A parcel that DID arrive, late enough that what was in it may be unsafe —
 * the customer has to be warned. These orders are status='delivered', which is
 * terminal, so carrierAlertSql above can never see them; they stay on the card
 * until an operator marks the case handled (air_delay_cleared_at).
 *
 * The lateness rule itself is lib/delay-case.js's, per delivery mode.
 */
function airAlertSql(alias = 'o') {
  const q = alias + '.';
  return `EXISTS (
        SELECT 1 FROM retail_shipments sha
         WHERE sha.order_id = ${q}id
           AND ${delayCase.lateShipmentSql('sha')}
           AND sha.air_delay_cleared_at IS NULL)`;
}

/**
 * Meituan (view-only channel) never writes tracking_status/scenario — the
 * platform runs its own rider and its own customer contact, and it exposes no
 * explicit "delivery failed" label; an undeliverable order just stalls, then
 * flips to 已取消/退款. So the one delivery signal worth an operator's
 * follow-up is an in-flight order well past its promised time that the
 * auto-deliver-past-eta sweep (routes/meituan-internal.js) has not closed:
 *   • has an ETA, now >2h past it — the sweep closes stuck orders at +1h, so
 *     anything still open past +2h means the sweep missed it or the daemon is
 *     down (a genuine "check it" case, not routine lateness);
 *   • no ETA at all — the orphan the sweep cannot catch — stuck 'dispatched'
 *     >3h since the platform last updated it.
 *
 * Cancel/refund is a money event owned by the Refunds card, so it stays out of
 * here to keep this one about delivery rather than billing. Times are UTC both
 * sides (channel_eta / channel_status_at stored UTC; datetime('now') UTC).
 */
function meituanAlertSql(alias = 'o') {
  const q = alias + '.';
  return `${q}channel = 'meituan' AND ${q}status = 'dispatched'
         AND (
            (${q}channel_eta IS NOT NULL AND ${q}channel_eta != ''
                 AND datetime(${q}channel_eta, '+2 hour') <= datetime('now'))
         OR ((${q}channel_eta IS NULL OR ${q}channel_eta = '')
                 AND datetime(COALESCE(${q}channel_status_at, ${q}placed_at), '+3 hour') <= datetime('now'))
         )`;
}

/**
 * How long past a promised local ETA we wait before calling a rider stuck.
 * Mirrors the autoDeliverLocalEtaForTenant sweep so the two agree on when an
 * order is overdue.
 */
const LOCAL_STUCK_GRACE_MIN = 15;

/**
 * Our own same-city (青云 Qingyun rider) deliveries that are stuck BEFORE
 * pickup — a rider was requested and none grabbed it, so nothing is carrying
 * the order and the ETA sweep defers to the fresh tracking. Those sit on
 * 'dispatched' silently.
 *
 * Local deliveries carry NO waybill and NO tracking_status; the live rider
 * stage lives in delivery_jobs. Two sweeps already close the happy paths (the
 * drop-off signal flips it delivered on order_status 50, and the ETA sweep
 * closes it on local_eta+grace when there is no live tracking) — this is the
 * gap neither touches.
 *
 * RETURNS THE WHOLE SET, NEVER A PAGE. The caller slices for its preview; the
 * COUNT must not be sliced, which it silently was before this moved here —
 * `localStuck.length` was read off an already-capped array, so a shop with
 * nine stuck riders and a preview of eight had a card that said eight.
 *
 * delivery_jobs is always present (created at boot), but a pre-migration
 * tenant is tolerated: a missing column or table yields an empty set rather
 * than taking the other three sub-types down with it.
 *
 * ── AN OPERATOR-SET ARRIVAL TIME MEANS A PERSON HAS THIS ──────────────────
 * Reported by Ash 2026-09-21 off the live phone, on TC000812: "we order
 * delivery manually not from the system, and added a time manually — seems
 * that the system ignores it."
 *
 * The paragraph above assumes a rider was REQUESTED THROUGH US. When the
 * courier is booked by hand, that assumption is false and unfixable from the
 * data: the Qingyun copy is created by auto-push, nobody ever dispatches a
 * carrier through it, and so `order_status` sits at 20 (待配送 — "nobody was
 * sent for it", routes/retail.js _qingyunCourierCommitted) for good. The test
 * above reads that unmoving 20 as "a rider was requested and none grabbed it",
 * and fifteen minutes after the typed time the order lands on the card. Not
 * once — on EVERY order handled that way, for ever.
 *
 * So the ETA's PROVENANCE decides. `eta_source = 'manual'` is written only by
 * an operator typing or clearing the time (routes/retail.js PUT/DELETE
 * .../eta), and the courier daemon is already forbidden from overwriting it
 * (scripts/qingyun-daemon.js stampEta) — the flag already means "a person
 * settled this", and this is the second reader to honour it rather than a new
 * thing to maintain. A person who types an arrival time has arranged the
 * delivery; telling them nobody is coming is the system arguing with the only
 * human who knows.
 *
 * WHAT IS DELIBERATELY NOT EXEMPTED: the other three sub-types. Those are
 * CARRIER-REPORTED facts — an exception, a late cold-chain leg, a Meituan
 * order past its time — and a typed ETA says nothing about any of them. Only
 * this one is an inference about a rider, and only an inference can be wrong
 * in the way Ash described.
 *
 * THE COST, STATED: an order the system DID dispatch, whose rider then
 * vanished, goes unflagged if someone has typed a time on it. Accepted with
 * Ash 2026-09-21 — typing the time is that person saying they have it —
 * and the order's own rider card still reads "Finding a rider · 正在找骑手".
 */
function localStuckRows(db, now) {
  let rows;
  // `eta_source` arrived by addColumn and an unmigrated tenant may not carry
  // it. Asked once, here, rather than let a missing column throw into the
  // catch below — that would return [] and quietly drop the whole rider check
  // for that tenant, which is a bigger hole than the one being closed.
  let hasSource = false;
  try {
    hasSource = db.prepare('PRAGMA table_info(retail_shipments)').all()
      .some(c => c && c.name === 'eta_source');
  } catch { hasSource = false; }
  try {
    rows = db.prepare(`
      SELECT o.id, o.order_no, o.scheduled_for,
             (SELECT sh.local_eta FROM retail_shipments sh
               WHERE sh.order_id = o.id AND sh.mode = 'local'
                 AND sh.local_eta IS NOT NULL AND sh.local_eta != ''
               ORDER BY sh.id ASC LIMIT 1) AS local_eta,
             ${hasSource ? `(SELECT sh.eta_source FROM retail_shipments sh
               WHERE sh.order_id = o.id AND sh.mode = 'local'
                 AND sh.local_eta IS NOT NULL AND sh.local_eta != ''
               ORDER BY sh.id ASC LIMIT 1)` : 'NULL'} AS eta_source,
             (SELECT j.order_status FROM delivery_jobs j
               WHERE j.retail_order_id = o.id AND j.order_status IS NOT NULL
                 AND j.updated_at > datetime('now','-30 minutes')
               ORDER BY j.updated_at DESC LIMIT 1) AS job_os,
             COALESCE(NULLIF(TRIM(c.nickname), ''), NULLIF(TRIM(o.recipient_name), ''), NULLIF(TRIM(o.recipient_phone), ''), NULLIF(TRIM(c.phone), '')) AS buyer
        FROM retail_orders o
        LEFT JOIN retail_customers c ON c.id = o.customer_id
       WHERE o.fulfillment_type = 'delivery' AND o.status = 'dispatched'
    `).all();
  } catch (e) {
    if (!/no such column|no such table/i.test(e.message)) throw e;
    return [];                                     // pre-migration tenant → skip
  }
  const nowD = now || new Date();
  return rows.map(r => {
    // FIRST, because it outranks everything below it: a person typed this
    // time, so a person has this delivery. Nothing derived from a courier job
    // nobody is driving can overrule that. See the header.
    //
    // The two sub-queries above are deliberately identical but for the column,
    // so both read the SAME shipment row; a time and a provenance taken off
    // different parcels would be worse than having neither.
    if (String(r.eta_source || '').trim() === 'manual') return null;
    // Must have a FRESH live Qingyun job that hasn't reached pickup (os < 30) —
    // i.e. still finding / awaiting a rider. An in-transit rider (os >= 30) is
    // on the way and resolves on drop-off, so it's not "stuck".
    if (r.job_os == null || r.job_os >= 30) return null;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(r.local_eta || '').trim());
    if (!m) return null;
    if (r.scheduled_for) {
      const sched = new Date(r.scheduled_for);
      if (!isNaN(sched.getTime()) &&
          new Date(sched.getFullYear(), sched.getMonth(), sched.getDate()).getTime() >
          new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()).getTime()) {
        return null;   // scheduled for a later day — not overdue today
      }
    }
    const eta = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), +m[1], +m[2], 0, 0);
    if (nowD.getTime() <= eta.getTime() + LOCAL_STUCK_GRACE_MIN * 60_000) return null;
    // The row's age is "how long past the promised time", so it ages from the
    // resolved ETA — the very instant this filter just judged it late by. Ship
    // that instant rather than the bare "HH:MM", so the client never has to
    // re-resolve a wall-clock string against its own timezone. Deliberately the
    // SAME Date the test above used: if the two ever drifted, a row could appear
    // while claiming it wasn't late yet.
    return { ...r, waiting_since: eta.toISOString() };
  }).filter(Boolean);
}

/**
 * The whole card, as a WHERE fragment plus its bound parameters — what the
 * orders list, its pager COUNT and its CSV export all filter on for
 * `status=delayed`.
 *
 * The local-rider ids are bound rather than interpolated. An empty set yields
 * no disjunct at all: `id IN ()` is not valid SQLite, and a disjunct that can
 * never be true is not worth emitting.
 */
function alertFilter(db, alias = 'o', now) {
  const parts = [carrierAlertSql(alias), airAlertSql(alias), meituanAlertSql(alias)];
  const params = [];
  // The ROWS, not just the ids. The card previews these and used to fetch them
  // with a SECOND localStuckRows call of its own — two reads of a live rider
  // table a few milliseconds apart, which can disagree about whether a rider
  // has just picked up. Handing them back makes the filter and the preview one
  // read.
  const stuck = localStuckRows(db, now);
  const ids = stuck.map(r => r.id).filter(id => Number.isInteger(id));
  if (ids.length) {
    parts.push(`${alias}.id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  return { sql: '(' + parts.map(p => `(${p})`).join(' OR ') + ')', params, stuck };
}

/**
 * HOW MANY ORDERS ARE ON THE CARD — the same set the list shows, each order
 * counted once.
 *
 * THE CARD USED TO ADD ITS FOUR SUB-TYPES TOGETHER, and the four sub-types
 * OVERLAP. `alertFilter` ORs them, so an order that is two kinds of trouble at
 * once is one row in the list and was two in the total. The card said 3 and
 * opened a list of 2.
 *
 * It is not a corner case, it is the commonest incident on the card: a Meituan
 * order past its promised time whose Qingyun rider never picked it up is BOTH
 * `meituanAlertSql` and `localStuckRows` — one order, one phone call, counted
 * twice. (Meituan mirror rows are fulfilled by our own rider; the orders list
 * route says so where it joins delivery_jobs.) A multi-parcel order with a
 * carrier exception on one parcel and a cold-chain parcel that landed late on
 * another is the same story in `carrierAlertSql` + `airAlertSql`.
 *
 * So the count is a COUNT of the filter, not a sum of its parts. That is the
 * same rule this file already applies to the predicates themselves: the number
 * on the card and the length of the list are ONE fact, not two that have to
 * agree. Takes the filter the caller already built so the live-rider table is
 * read once per request rather than twice.
 */
function alertCount(db, filter, alias = 'o') {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM retail_orders ${alias} WHERE ${filter.sql}`
  ).get(...filter.params).n;
}

module.exports = {
  LOCAL_STUCK_GRACE_MIN,
  carrierAlertSql, airAlertSql, meituanAlertSql, localStuckRows,
  alertFilter, alertCount,
};
