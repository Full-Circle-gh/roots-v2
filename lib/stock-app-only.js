// WHAT A STOCK-APP-ONLY ROLE MAY CALL.
//
// A role carrying `stock_app_only` (kitchen and store_stock ship with it) is
// confined to the /stock app and the handful of endpoints that app uses. The
// gate itself lives in server.js, on every request with a Tacet session; this
// is the list it consults, pulled out so it can be tested without booting the
// server — the list is the whole decision, and it was wrong once already.
//
// #262 put the kitchen queue in /stock and this list did not know about it, so
// every call the queue made came back `kitchen_add_only` before any route ran.
// The capability layer never got a look. The queue was invisible to the only
// role it was built for, and nothing anywhere said why.
//
// METHOD-SCOPED, because the path cannot carry the distinction. GET
// /api/restock is the kitchen's queue; POST /api/restock raises a transfer.
// Admitting the path alone would hand a confined role the create route, and
// cap-routes only refuses that on a tenant with rbac_enforce switched on — so
// the confinement would depend on a flag that is dark for most tenants.
//
// This is a floor, not the whole gate. routes/restock.js narrows what gets
// through: _kitchenScopedSession confines a fulfil-without-pick operator to
// kitchen requests, so the transfer half of these very URLs still 403s.
'use strict';

function stockAppOnlyAllows(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '');
  if (p === '/api/retail-admin/quick-stock/context') return true;
  if (/^\/api\/retail-admin\/stores\/\d+\/stock(\/\d+)?$/.test(p)) return true;
  if (p === '/api/backend/logout') return true;
  // The kitchen queue: read the list, open one, move it along.
  if (m === 'GET' && (p === '/api/restock' || /^\/api\/restock\/\d+$/.test(p))) return true;
  if (m === 'PUT' && /^\/api\/restock\/\d+\/status$/.test(p)) return true;
  // Production: record what was made, and read the gap-reason vocabulary the
  // screen offers. Added WITH the screen rather than after it — #262 shipped
  // the kitchen queue without touching this list and the queue was invisible to
  // the only role it was built for, because every call died here before any
  // route ran. A screen and its door go in together.
  if (m === 'POST' && p === '/api/retail-admin/production') return true;
  if (m === 'GET' && p === '/api/retail-admin/production/reasons') return true;
  return false;
}

module.exports = { stockAppOnlyAllows };
