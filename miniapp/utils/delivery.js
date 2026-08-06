// Delivery context for the shopper who is BROWSING — one question only: would
// the order to their address ride the same-day local run out of a shop?
//
// Why the catalog cares: PRE-ORDER is for orders we SHIP. A sold-out product on
// the 'backorder_gz' policy stays orderable because the parcel leaves after the
// next batch or restock; an order served off the shelves the local run loads
// from has nothing behind it, so the checkout refuses it (localPreorderLine).
// The shop grid, the PDP and the favourites page used to render the pill from
// the product flag alone, so a Tianhe customer with a 2 km address was invited
// to reserve items the checkout would then refuse. Those pages ask this module
// instead and show the honest dead SOLD OUT pill.
//
// Being IN Guangzhou is not the question. The outer ship-districts (花都/番禺/
// 南沙/从化/增城) are same-city and still ship by courier from the out-of-city
// warehouse on the batch cadence unless the shopper buys the same-day extra —
// a pre-order is as safe for them as it is for Shanghai. So this reads
// `local_run`, not `same_city`: both are stamped on every saved address by
// GET /api/retail/addresses, and neither question is re-implemented here.
//
// Browsing precedes the slot pick, so a ship-district shopper reads as "not on
// the run" and keeps the pill; if they later buy the same-day extra the
// checkout refuses the line, which lands in the ordinary insufficient_stock
// path. Unknown — not signed in, no saved address, request failed — resolves
// the same permissive way, with the checkout gate having the last word.

const api = require('./api');

// Addresses change rarely; a short TTL keeps the shop's onShow cheap while
// still noticing a switch made on another tab. invalidate() covers the edits
// we make ourselves (add / edit / delete / tap-to-select).
const TTL_MS = 2 * 60 * 1000;

let _rows = null;      // [{ id, local_run, is_default }] — trimmed, never the PII
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
function onLocalRun() {
  const r = _activeRow();
  return !!(r && r.local_run);
}

// Pre-order may be offered to this shopper. The inverse of onLocalRun(), named
// for what the caller is deciding.
function preorderAllowed() {
  return !onLocalRun();
}

// Refresh the address book (cached, deduped, never rejects). Resolves to the
// current onLocalRun() so a page can compare it against what it rendered with.
function load(force) {
  if (!force && _rows && Date.now() - _at < TTL_MS) return Promise.resolve(onLocalRun());
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
        local_run: !!a.local_run,
        is_default: !!a.is_default,
      }));
      _at = Date.now();
    })
    .catch(() => { /* signed out / offline — keep whatever we already knew */ })
    .then(() => { _inflight = null; return onLocalRun(); });
  return _inflight;
}

// Seed the cache from an address list a page already fetched (the address book
// pulls the same endpoint), so switching back to the shop tab re-badges from
// the new pick without another round-trip.
function prime(list) {
  if (!Array.isArray(list)) return;
  _rows = list.map(a => ({
    id: a.id,
    local_run: !!a.local_run,
    is_default: !!a.is_default,
  }));
  _at = Date.now();
}

// Drop the cache after any address edit so the next load() sees the change.
function invalidate() { _rows = null; _at = 0; }

module.exports = { onLocalRun, preorderAllowed, load, prime, invalidate };
