// Add-to-cart notices — which one is due, and whether this customer has already
// met it. The card that draws them is components/cart-notice; this file holds
// every rule, so there is one answer rather than one per screen.
//
// A notice arrives on the product payload as `cart_notice` (routes/retail.js
// resolves it from the tenant's `cart_notices.list`). The client never reads
// that config list itself: two resolvers is how the shop grid and the product
// page start showing different notices for the same bottle.
//
// SEEN IS PER VERSION, NOT PER NOTICE, and the key shape is popup-manager's for
// the reason its own comment gives at length: keyed on the id alone, the first
// render marks a notice seen forever, so a tenant who fixes a wrong word ships
// the fix to a phone that can never display it. Every admin save stamps
// `updated_at`, which hands the edited notice a fresh identity and lets it show
// once more. An untouched notice still shows exactly once.
//
// SEEN IS MARKED WHEN THE CARD GOES UP, not when it is closed — same as the
// pop-ups. A customer who kills the app mid-card has been shown it, and a notice
// that re-raised itself until formally acknowledged would be a notice people
// learn to tap past.

const listeners = new Set();
let pending = [];

function seenKey(n) {
  return 'cart_notice_seen:' + n.id + ':' + (n.updated_at || 0);
}

function hasSeen(n) {
  try { return !!wx.getStorageSync(seenKey(n)); } catch { return false; }
}

function markSeen(n) {
  try { wx.setStorageSync(seenKey(n), Date.now()); } catch { /* storage full / private — showing it twice is the acceptable failure */ }
}

// Called from cart.add() with whatever that call site passed in. Most callers
// hand over a whole product row from the API, which already carries the notice;
// the two that build a literal (the PDP's add, the grid's quick-add) copy the
// field across explicitly. A caller with no notice on it is the ordinary case
// and costs nothing.
//
// Returns true when something is now waiting, so the caller can hold a
// navigation it was about to make.
function queue(product) {
  const n = product && product.cart_notice;
  if (!n || !n.id) return false;
  if (hasSeen(n)) return false;
  if (pending.some(p => p.id === n.id)) return true;   // two of the same bottle, one card
  pending.push(n);
  listeners.forEach(fn => { try { fn(); } catch { /* a dead screen must not stop a live one */ } });
  return true;
}

// The next notice to show, marked seen as it leaves. Notices seen since they
// were queued are walked PAST rather than stopping the queue — §196's rule for
// the checkout queue, and for the same reason: a queue that stalls on one dead
// entry swallows everything behind it.
function takeNext() {
  while (pending.length) {
    const n = pending.shift();
    if (hasSeen(n)) continue;
    markSeen(n);
    return n;
  }
  return null;
}

function waiting() { return pending.length; }

function onQueued(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Tests only — the module holds process-wide state by design (the queue has to
// survive a page change), so a suite needs a way back to empty.
function _reset() { pending = []; listeners.clear(); }

module.exports = { queue, takeNext, waiting, onQueued, seenKey, hasSeen, markSeen, _reset };
