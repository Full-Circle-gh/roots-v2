// Delivery context for the shopper who is BROWSING — one question only:
// is the address their order would go to inside Guangzhou (same-city, local
// scooter delivery)?
//
// Why the catalog cares: PRE-ORDER is an out-of-city offer. A sold-out product
// on the 'backorder_gz' policy stays orderable only when the order ISN'T
// Guangzhou same-day — the local kitchen can't conjure a batch for today's run
// (lib/inventory.js → requiresStockGate, enforced at checkout). The shop grid,
// the PDP and the favourites page used to render the pill from the product flag
// alone, so a Tianhe customer with a 2 km address was invited to reserve items
// the checkout would then refuse. Those pages now ask this module and show the
// honest dead SOLD OUT pill instead.
//
// `same_city` is the server's own verdict, stamped on every saved address by
// GET /api/retail/addresses, so the 广州 matcher is never re-implemented here.
//
// Unknown — not signed in, no saved address, request failed — resolves to NOT
// same-city: the catalog keeps its permissive out-of-city behaviour and the
// checkout gate still has the last word.

const api = require('./api');

// Addresses change rarely; a short TTL keeps the shop's onShow cheap while
// still noticing a switch made on another tab. invalidate() covers the edits
// we make ourselves (add / edit / delete / tap-to-select).
const TTL_MS = 2 * 60 * 1000;

let _rows = null;      // [{ id, same_city, is_default }] — trimmed, never the PII
let _at = 0;
let _inflight = null;

function _app() {
  try { return getApp(); } catch (e) { return null; }
}

// The address the order would actually go to: whatever checkout last landed on
// (globalData.activeAddressId), else the saved default — the card the address
// book shows as SELECTED.
function _activeRow() {
  if (!_rows || !_rows.length) return null;
  const app = _app();
  const id = app && app.globalData ? app.globalData.activeAddressId : null;
  if (id) {
    const picked = _rows.find(r => Number(r.id) === Number(id));
    if (picked) return picked;
  }
  return _rows.find(r => r.is_default) || null;
}

// Synchronous verdict from whatever we last loaded. False until load() lands.
function sameCity() {
  const r = _activeRow();
  return !!(r && r.same_city);
}

// Pre-order may be offered to this shopper. The inverse of sameCity(), named
// for what the caller is deciding.
function preorderAllowed() {
  return !sameCity();
}

// Refresh the address book (cached, deduped, never rejects). Resolves to the
// current sameCity() so a page can compare it against what it rendered with.
function load(force) {
  if (!force && _rows && Date.now() - _at < TTL_MS) return Promise.resolve(sameCity());
  if (_inflight) return _inflight;
  const app = _app();
  // Wait out the silent wx.login so a cold start doesn't 401 and cache "no
  // addresses" for the rest of the TTL.
  const ready = app && app.authReady
    ? Promise.resolve(app.authReady).catch(() => {})
    : Promise.resolve();
  _inflight = ready
    .then(() => api.get('/api/retail/addresses'))
    .then((resp) => {
      const list = Array.isArray(resp) ? resp : (resp && resp.data) || [];
      _rows = list.map(a => ({
        id: a.id,
        same_city: !!a.same_city,
        is_default: !!a.is_default,
      }));
      _at = Date.now();
    })
    .catch(() => { /* signed out / offline — keep whatever we already knew */ })
    .then(() => { _inflight = null; return sameCity(); });
  return _inflight;
}

// Seed the cache from an address list a page already fetched (the address book
// pulls the same endpoint), so switching back to the shop tab re-badges from
// the new pick without another round-trip.
function prime(list) {
  if (!Array.isArray(list)) return;
  _rows = list.map(a => ({
    id: a.id,
    same_city: !!a.same_city,
    is_default: !!a.is_default,
  }));
  _at = Date.now();
}

// Drop the cache after any address edit so the next load() sees the change.
function invalidate() { _rows = null; _at = 0; }

module.exports = { sameCity, preorderAllowed, load, prime, invalidate };
