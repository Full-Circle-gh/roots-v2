// Cart state — kept in localStorage so it survives mini-app restarts.
// Tiny event-emitter so the cart tab can update its badge without polling.

const api = require('./api');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return api.BASE + u;
  return u;
}

const KEY = 'cart';

let state = null;
const listeners = new Set();

function load() {
  if (state) return state;
  try {
    const stored = wx.getStorageSync(KEY);
    state = stored && typeof stored === 'object'
      ? { items: stored.items || [], voucher: stored.voucher || null }
      : { items: [], voucher: null };
  } catch {
    state = { items: [], voucher: null };
  }
  return state;
}

function save() {
  try { wx.setStorageSync(KEY, state); } catch {}
  listeners.forEach(fn => { try { fn(state); } catch {} });
  updateBadge();
}

function get() { return load(); }
function count() { return load().items.reduce((s, i) => s + (i.qty || 0), 0); }
function subtotal() { return load().items.reduce((s, i) => s + (i.qty || 0) * (i.unit_price || 0), 0); }

function add(product, qty = 1, options = []) {
  load();
  const key = product.id + '|' + (options.map(c => c.choice_id).sort().join(',') || '');
  const existing = state.items.find(it => it.key === key);
  if (existing) {
    existing.qty += qty;
  } else {
    const regular = Number(product.price ?? product.sell_price) || 0;
    const eff = Number(product.effective_price) > 0 ? Number(product.effective_price) : regular;
    const isFlash = !!product.is_on_flash && eff < regular;
    state.items.push({
      key,
      product_id: product.id,
      name_en: product.name_en, name_cn: product.name_cn,
      sku: product.sku, size: product.size || product.weight,
      image: absUrl(product.image_url) || product.image_data || '',
      // Server reprices at /quote and /orders, so this is just display —
      // but keep it accurate so cart subtotal matches checkout.
      unit_price: eff,
      regular_price: isFlash ? regular : null,
      is_flash: isFlash,
      qty,
      options,
    });
  }
  save();
}

function setQty(key, qty) {
  load();
  const it = state.items.find(i => i.key === key);
  if (!it) return;
  if (qty <= 0) state.items = state.items.filter(i => i.key !== key);
  else it.qty = qty;
  save();
}

function remove(key) {
  load();
  state.items = state.items.filter(i => i.key !== key);
  save();
}

function clear() {
  state = { items: [], voucher: null };
  save();
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function updateBadge() {
  const n = count();
  if (n > 0) wx.setTabBarBadge({ index: 2, text: String(n) }).catch(() => {});
  else wx.removeTabBarBadge({ index: 2 }).catch(() => {});
}

module.exports = { get, count, subtotal, add, setQty, remove, clear, subscribe, updateBadge };
