// ── Remembering where a door is ───────────────────────────────────────────
// When the courier push cannot place an address, it parks and asks an operator
// to tap the building (docs/tacet-delivery-point-confirmation-spec.md §5). That
// answer used to live on one order and nowhere else, so the NEXT order to the
// identical address asked the identical question — the geocoder returns the
// same area for the same text every time, by construction, which is the same
// reasoning that stops the row retrying. Asking a question whose answer cannot
// change is a retry performed by a human.
//
// So an answered address is remembered here, and the drain reads this before it
// parks. DECIDED BY ASH 2026-09-21 (decisions §203), who asked for the reuse to
// be SILENT: a confirmation the operator always says yes to is the same tap the
// memory exists to remove.
//
// WHAT THIS IS NOT, and the distinction is the whole design: it is not a write
// back to `retail_customer_addresses`. D5 stands — the customer did not choose
// this spot, an operator did, and putting a staff guess under the customer's
// saved record would hide it where they can never see or correct it. This table
// is the operators' own record of answers they have already given, kept beside
// the customer's address rather than inside it.
//
// KEYED ON THE ADDRESS TEXT, NEVER ON THE CUSTOMER. A customer has more than
// one address, and a memory keyed on them would send every future order for
// every one of their addresses to a door somebody once tapped for a different
// one — silently, with nobody asked. Keyed on the text, a wrong answer reaches
// exactly the address it was given for, and the next edit of that text retires
// it (the key no longer matches), which is the same rule §5.1 already applies
// to a staff_pin on an order.

'use strict';

const addressPin = require('./address-pin');
const qingyunQueue = require('./qingyun-queue');

// Every field that describes WHERE, and all of them. A narrower key (drop the
// room number, say) would hit more often by treating two flats as one door —
// which is usually true and is not ours to assume. Exact text, exact answer.
const KEY_FIELDS = ['province', 'city', 'district', 'address', 'detail'];

function normPart(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

// The key, or null when there is nothing worth remembering. A missing street
// line is the refusal that matters: '广东省广州市' names a city, and a point
// remembered against a city would be handed to every future order that also
// failed to say more than one — the laundering §5 exists to prevent, arriving a
// week late through a cache.
function addressKey(addr) {
  const parts = KEY_FIELDS.map((k) => normPart(addr && addr[k]));
  if (!normPart(addr && addr.address)) return null;
  return parts.join('|');
}

// The same address as a person reads it. Stored alongside the key so the table
// can be audited by someone who has never seen the key format.
function addressText(addr) {
  return KEY_FIELDS.map((k) => normPart(addr && addr[k])).filter(Boolean).join(' ');
}

// The only two sources this table will store or return, and it is a whitelist
// rather than a filter on the way in for a reason: the source rides back out
// onto an order's snapshot, where lib/qingyun-payload reads it to decide
// whether MAX_DROP_KM applies. A remembered 'poi_picked' stays 'poi_picked' —
// promoting one to 'staff_pin' on the way out would hand a chosen name the
// distance exemption that only a tapped building earns.
const REMEMBERED_SOURCES = ['staff_pin', 'poi_picked'];

const REMEMBER_SQL = `
  INSERT INTO retail_delivery_point_memory
    (address_key, address_text, lat, lng, source, place_name,
     answered_order_id, answered_order_no, used_count, last_used_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(address_key) DO UPDATE SET
    address_text = excluded.address_text,
    lat = excluded.lat, lng = excluded.lng,
    source = excluded.source, place_name = excluded.place_name,
    answered_order_id = excluded.answered_order_id,
    answered_order_no = excluded.answered_order_no,
    used_count = 0, last_used_at = NULL,
    updated_at = CURRENT_TIMESTAMP`;

const RECALL_SQL = `
  SELECT address_key, address_text, lat, lng, source, place_name,
         answered_order_id, answered_order_no, used_count
    FROM retail_delivery_point_memory
   WHERE address_key = ?`;

const MARK_USED_SQL = `
  UPDATE retail_delivery_point_memory
     SET used_count = used_count + 1, last_used_at = CURRENT_TIMESTAMP
   WHERE address_key = ?`;

// Record the answer an operator just gave.
//
// SWALLOWS ITS OWN FAILURE, deliberately. The caller runs this inside the
// transaction that writes the point onto the order and requeues the push, and
// those two are what make the delivery happen. A memory that could abort them
// would trade a dispatch for a convenience: not remembering costs one tap on
// some future order, and a rolled-back confirm costs this order its rider.
function remember(db, { addr, lat, lng, source, placeName, orderId, orderNo } = {}) {
  const key = addressKey(addr);
  if (!key) return false;
  if (!REMEMBERED_SOURCES.includes(source)) return false;
  const pin = addressPin.readClientPin({ lat, lng });
  if (!pin) return false;
  try {
    db.prepare(REMEMBER_SQL).run(
      key, addressText(addr), pin.lat, pin.lng, source, placeName || null,
      orderId != null ? orderId : null, orderNo || null);
    return true;
  } catch (e) {
    console.error('[delivery point memory] could not remember:', e.message);
    return false;
  }
}

// Has this exact address already been answered? Returns the answer, or null.
//
// The stored coordinate is bounds-checked on the way out by the same reader the
// customer address form uses, and the source is re-checked against the
// whitelist: this row is being handed to a courier as a delivery target, and a
// row corrupted (or hand-edited) since it was written must not become one.
function recall(db, addr) {
  const key = addressKey(addr);
  if (!key) return null;
  let row;
  try { row = db.prepare(RECALL_SQL).get(key); } catch { return null; }
  if (!row) return null;
  if (!REMEMBERED_SOURCES.includes(row.source)) return null;
  const pin = addressPin.readClientPin({ lat: row.lat, lng: row.lng });
  if (!pin) return null;
  return {
    key, lat: pin.lat, lng: pin.lng, source: row.source,
    placeName: row.place_name || null,
    answeredOrderId: row.answered_order_id != null ? row.answered_order_id : null,
    answeredOrderNo: row.answered_order_no || null,
    usedCount: row.used_count || 0,
  };
}

function markUsed(db, key) {
  try { db.prepare(MARK_USED_SQL).run(key); } catch { /* a count, not a fact anyone routes on */ }
}

// The order's address snapshot with the remembered point written onto it.
//
// `geo_memory` is additive and is read by nothing: it is how a person looking
// at this order later learns the point was not placed for THIS order, and which
// order it was placed for. The reuse is silent on the screen (Ash's call); it is
// not silent in the record.
function pinnedSnapshot(addr, hit) {
  return {
    ...addr,
    lat: hit.lat, lng: hit.lng,
    geo_source: hit.source, geo_precision: null,
    geo_memory: hit.answeredOrderNo || String(hit.answeredOrderId || ''),
  };
}

// Is this order already carrying the remembered point? Then the memory has
// nothing to add and the row parks as it would have.
//
// This is the loop guard, and it is not theoretical: apply a point, requeue,
// and the next drain pass reads the same memory. Both remembered sources are
// trusted by lib/qingyun-payload so a correct application never parks again —
// but a guard that depends on a predicate in another module staying as it is
// today is not a guard.
function alreadyApplied(addr, hit) {
  return addressPin.samePin({ lat: addr && addr.lat, lng: addr && addr.lng }, hit)
      && String((addr && addr.geo_source) || '') === hit.source;
}

// ── The orders that are waiting on the SAME answer, right now ─────────────
// The drain reads this memory on its way past, which covers every order that
// arrives AFTER an address is answered. It does not cover the ones already
// sitting parked: a parked row does not retry (that is the whole point of the
// state), so two orders to one address would ask the identical question twice
// and the operator would answer it twice.
//
// So the confirm releases its twins. Each parked row is matched on the KEY —
// not on the customer, not on a text `LIKE` — so a release reaches exactly the
// addresses that are the same address, which is the same rule the memory itself
// follows. A closed order is skipped: it is parked because nobody is delivering
// it, and requeuing one would send a rider for something that is not happening.
//
// Runs AFTER the confirm's transaction commits, deliberately. These are other
// orders' dispatches; a failure on one must not roll back the confirm the
// operator just made, and a confirm that failed must release nothing.
const WAITING_SQL = `
  SELECT q.id, q.retail_order_id, q.attempts, q.status,
         o.order_no, o.status AS order_status, o.address_json
    FROM qingyun_push_queue q
    JOIN retail_orders o ON o.id = q.retail_order_id
   WHERE q.status IN ('needs_point', 'awaiting_choice')
     AND q.qingyun_order_id IS NULL
     AND q.retail_order_id <> ?`;

function releaseWaiting(db, hit, { excludeOrderId } = {}) {
  if (!hit || !hit.key) return [];
  let rows = [];
  try { rows = db.prepare(WAITING_SQL).all(excludeOrderId != null ? excludeOrderId : -1) || []; }
  catch { return []; }
  const released = [];
  for (const r of rows) {
    if (qingyunQueue.isClosedOrderStatus(r.order_status)) continue;
    let addr = {};
    try { addr = JSON.parse(r.address_json || '{}') || {}; } catch { continue; }
    if (addr.pickup) continue;
    if (addressKey(addr) !== hit.key) continue;
    if (alreadyApplied(addr, hit)) continue;
    try {
      db.prepare('UPDATE retail_orders SET address_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(pinnedSnapshot(addr, hit)), r.retail_order_id);
      // The same statement the drain uses on a memory hit, and the same
      // reasoning: this row never spent an attempt on a push that could have
      // worked, and it is not a human confirm, so the budget is handed back
      // rather than reset.
      const done = db.prepare(qingyunQueue.RECALLED_POINT_SQL).run(r.attempts, r.id).changes > 0;
      if (done) released.push(r.order_no || String(r.retail_order_id));
    } catch (e) {
      console.error('[delivery point memory] could not release', r.retail_order_id, e.message);
    }
  }
  if (released.length) markUsed(db, hit.key);
  return released;
}

module.exports = {
  addressKey, addressText, remember, recall, markUsed, pinnedSnapshot, alreadyApplied,
  releaseWaiting, WAITING_SQL,
  REMEMBERED_SOURCES, REMEMBER_SQL, RECALL_SQL, MARK_USED_SQL, KEY_FIELDS,
};
