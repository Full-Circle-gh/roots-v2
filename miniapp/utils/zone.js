// Browse-time shopper-zone resolver.
//
// Ready-to-eat meals (store_products.is_batch_made) are cooked on a fixed batch
// cadence (see batch.schedule + computeBatchNotice on the server). Their stock
// should only gate GUANGZHOU same-day shoppers — an out-of-city customer can
// order a sold-out meal because it simply ships on the next cook batch, never
// same-day. But the product / shop pages decide "sold out" BEFORE checkout, so
// they don't naturally know the delivery address the way checkout does.
//
// This module resolves the shopper's Guangzhou status lazily and caches it on
// globalData, returning:
//   true  → known Guangzhou        → keep the hard SOLD-OUT block on meals
//   false → known out-of-city      → meals stay orderable ("Next batch")
//   null  → unknown (signed out /  → treated like out-of-city for the soft
//           no saved address yet)     Next-batch display; the real same-day
//                                      gate still runs at checkout regardless.

const api = require('./api');

// Mirror of lib/inventory.js isGuangzhouAddress — same normalisation so this
// browse-time guess matches the server's checkout-time routing decision.
function isGuangzhouAddress(address) {
  if (!address) return false;
  const city = String(address.city || '').replace(/市$/, '').trim().toLowerCase();
  if (city === '广州' || city === 'guangzhou') return true;
  const blob = [address.address, address.detail, address.city, address.district]
    .filter(Boolean).join(' ');
  return /广州/.test(blob) || /guangzhou/i.test(blob);
}

// Sync best-known answer so a page can render immediately, then refine once
// resolveGz() settles. Prefers a full address cached by checkout; falls back to
// the last classification we stored.
function cachedGz() {
  const g = getApp().globalData;
  if (g.activeAddress) return isGuangzhouAddress(g.activeAddress);
  return (typeof g.shopperIsGz === 'boolean') ? g.shopperIsGz : null;
}

let _inflight = null;
// Resolve (and cache) the shopper's Guangzhou status. Reads the saved address
// list once and picks the active address (the one last used at checkout), else
// the default, else the first. Returns null when signed out or with no saved
// address — the caller treats null as "not Guangzhou" for the soft display.
function resolveGz() {
  const app = getApp();
  const g = app.globalData;
  if (g.activeAddress) return Promise.resolve(isGuangzhouAddress(g.activeAddress));
  if (!g.token) return Promise.resolve(null);
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await api.get('/api/retail/addresses');
      const list = Array.isArray(r) ? r : (r && r.data) || [];
      if (!list.length) { g.shopperIsGz = null; return null; }
      const pick = list.find(a => a.id === g.activeAddressId)
                || list.find(a => a.is_default)
                || list[0];
      g.activeAddress = pick;
      const gz = isGuangzhouAddress(pick);
      g.shopperIsGz = gz;
      return gz;
    } catch (e) {
      return null;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

module.exports = { isGuangzhouAddress, cachedGz, resolveGz };
