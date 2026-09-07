'use strict';

// What each fulfilment type MEANS. One place, because the alternative is ~30
// call sites each deciding for themselves what a walk-in is — which is how
// 'counter' spent its first day being stored correctly and read as a delivery
// everywhere.
//
//   delivery — goods leave on a courier or a rider to an address.
//   pickup   — promised now, collected later at a store. There is a waiting
//              period, a customer to notify, and a state where it is owed.
//   counter  — handed over at the till in the same moment it was paid.
//
// A counter sale is BORN FULFILLED, NOT BORN CLOSED. Nothing ships, nothing is
// collected later, nothing is sent, nothing is chased. But money and paperwork
// still move after the goods leave: a walk-in can ask for a fapiao and can be
// refunded, so the invoice worklist and the refund pipeline keep counting it.
// Only fulfilment is finished at the counter.
const FULFILMENT_TYPES = ['delivery', 'pickup', 'counter'];

function ftOf(o) {
  return String((o && o.fulfillment_type) || '').toLowerCase();
}

// Handed over at the till. Terminal on payment.
function isCounter(o) {
  return ftOf(o) === 'counter';
}

// Collected later at a store. Has a waiting period and a customer to notify.
function isPickup(o) {
  return ftOf(o) === 'pickup';
}

// Nothing goes on a courier: no shipment rows, no waybill, no tracking, no
// ship-by deadline, no dispatch. True for pickup AND counter, for different
// reasons — the customer comes to the goods, or already has them.
//
// Use this in place of `=== 'pickup'` at any site whose real question is "does
// a parcel leave?". Do NOT use it where the question is "is there a collection
// window" — that is pickup alone, and counter has no window because there is
// no wait.
function shipsNothing(o) {
  const t = ftOf(o);
  return t === 'pickup' || t === 'counter';
}

// Channels whose orders are MIRRORED IN from someone else's system. We do not
// accept, prepare, pack, dispatch or enter a waybill for one — the platform
// that owns the order does all of that, and we hold the row to deduct stock and
// show progress. So no parcel of ours ever leaves on a mirrored order.
//
// This is NOT `shipsNothing` and must not be folded into it, however close the
// two read. `shipsNothing` answers "does a parcel of ours leave?" and is what
// maybeEnqueueQingyunPush gates on — and a Meituan order IS fulfilled by a
// Qingyun rider, so widening that predicate would stop the rider push on the
// channel that most needs it. This one answers a different question: "is this
// order ours to fulfil at all?"
//
// The list is the one public/retail-admin/04-orders.js's ordIsReadonlyChannel
// has used since these channels landed; naming it here is what lets the server
// hold the same set the drawer does.
const MIRRORED_CHANNELS = ['meituan', 'eleme', 'gzgrocery'];

function isMirroredChannel(o) {
  return MIRRORED_CHANNELS.includes(String((o && o.channel) || '').toLowerCase());
}

// Is there someone waiting to be told something? A delivery has a recipient
// expecting a parcel; a pickup has a customer to call when it is ready. A
// counter sale's customer walked out with the goods, so every notification
// about handing them over is describing something they watched happen.
function notifiesOnHandover(o) {
  return !isCounter(o);
}

// A counter sale reaches its terminal state the moment it is PAID, not the
// moment the row is created: staff can key one in as pending and let the
// customer settle it by QR at /pay/:token seconds later, which is a normal till
// flow. So the flip belongs on the paid transition, not on the INSERT.
//
// The terminal state is 'delivered' — the generic "customer has the goods"
// state whose LABEL has always varied by fulfilment type (pickup already reads
// "Picked up"). Counter is a third label, not a fourth state. Reusing it means
// every existing `status IN ('paid','preparing',…)` worklist excludes counter
// sales by construction, instead of each one having to remember a new value.
function isTerminalOnPaid(o) {
  return isCounter(o);
}

module.exports = {
  FULFILMENT_TYPES,
  MIRRORED_CHANNELS,
  ftOf,
  isCounter,
  isPickup,
  shipsNothing,
  isMirroredChannel,
  notifiesOnHandover,
  isTerminalOnPaid,
};
