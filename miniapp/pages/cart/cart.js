// Cart tab — reads local cart state. Editable qty steppers + delete.
// Free-shipping bar pulls the threshold from config.fees.freeShippingThreshold.

const cart   = require('../../utils/cart');
const config = require('../../utils/config');
const lang   = require('../../utils/lang');
const api    = require('../../utils/api');

Page({
  data: {
    items: [],
    subtotal: 0,
    savedTotal: '',
    threshold: 399,
    remaining: 0,
    unlocked: false,
    pct: 0,
    lang: 'en',
    showBindModal: false,
    copy: { title: 'Almost yours.', kicker: 'YOUR BASKET', empty: 'Your basket is empty — shop the garden →', checkout: 'CHECK OUT' },
  },

  onLoad() {
    this.unsubscribe = cart.subscribe(() => this.recompute());
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe();
  },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.recompute();
    // The free-shipping bar reads fees.freeShippingThreshold from the cached
    // config; if it isn't warm yet, fetch + re-render so the bar isn't stuck
    // on the 399 fallback.
    config.load().then(() => this.recompute()).catch(() => {});
    // Prefer the customer's default-address zone threshold so the bar matches
    // checkout (e.g. ¥199 in Tianhe, not the global ¥399). Falls through to the
    // global on failure (not logged in, no saved address).
    this.loadZoneThreshold();
    // Cart unit_prices are frozen at add-time; re-price against the server so
    // flash sales that started/ended since show the CURRENT price + savings.
    this.repriceFromServer();
    // Defensive: re-fire the tab-badge update on every cart-tab show.
    // Some base-library versions silently ignore wx.removeTabBarBadge
    // when it's invoked from a non-tab page (e.g. during checkout's
    // cart.clear() right before redirect), leaving a stale "1" badge.
    cart.updateBadge();
    const tb = this.getTabBar && this.getTabBar();
    if (tb && tb.setSelected) tb.setSelected('pages/cart/cart');
  },

  recompute() {
    const L = this.data.lang;
    const state = cart.get();
    const subtotal = cart.subtotal();
    // Free-shipping threshold. Prefer the customer's default-address zone value
    // (fetched by loadZoneThreshold) so the bar matches checkout; fall back to
    // the global default from Settings → Checkout & fees. 0 = always free.
    const t = this._zoneThreshold != null
      ? this._zoneThreshold
      : (Number(config.get('fees.freeShippingThreshold', 399)) || 0);
    const alwaysFree = t <= 0;
    // Round UP to the next whole ¥ so the displayed gap never *understates*
    // what's needed (¥146.39999… → ¥147). Subtotal can be fractional from
    // discounts, but the cart bar reads cleaner as a round number.
    const remainingRaw = alwaysFree ? 0 : Math.max(0, t - subtotal);
    const remaining = Math.ceil(remainingRaw);
    // A line shows a strikethrough "was" price + feeds the "You saved" tally
    // when it's on flash OR it's a bundle priced below its components' combined
    // worth (bundle_worth, server-computed, frozen on the cart item at add-time).
    // Flash takes priority. Mirrors checkout's lineSaveFields so the saving the
    // customer saw on the product page is shown here AND at checkout — every
    // discount, all the way through.
    let flashSavings = 0, bundleSavings = 0, markdownSavings = 0;
    const itemRows = state.items.map(it => {
      const qty  = Number(it.qty) || 0;
      const unit = Number(it.unit_price) || 0;
      const onFlash   = !!it.is_flash && it.regular_price != null && Number(it.regular_price) > unit;
      const worth     = Number(it.bundle_worth) || 0;
      const onBundle  = !onFlash && worth > unit;
      // Everyday "was" markdown (compare_at_price). Flash + bundle take priority.
      const cmp       = Number(it.compare_at_price) || 0;
      const onMarkdown = !onFlash && !onBundle && cmp > unit;
      const lineSave = onFlash ? (Number(it.regular_price) - unit) * qty
                     : onBundle ? (worth - unit) * qty
                     : onMarkdown ? (cmp - unit) * qty : 0;
      if (onFlash)    flashSavings    += lineSave;
      if (onBundle)   bundleSavings   += lineSave;
      if (onMarkdown) markdownSavings += lineSave;
      const wasN = onFlash ? Number(it.regular_price) * qty : onBundle ? worth * qty : onMarkdown ? cmp * qty : 0;
      return {
        ...it,
        display_name: lang.pick(it.name_en, it.name_cn, L),
        display_size: lang.pickLabel(it.size, L),
        // Chosen options (e.g. dressing). Labels were localised at add-time.
        display_options: (it.options || []).map(o => o.label).filter(Boolean).join(' · '),
        line_total: (unit * qty).toFixed(2),
        regular_total: (onFlash || onBundle || onMarkdown) ? wasN.toFixed(2) : '',
        // Per-line "save ¥X" tag — mirrors the checkout receipt so the saving is
        // spelled out on every discounted row, not just the basket-wide total.
        save_text: lineSave > 0 ? (L === 'cn' ? '省 ¥' : 'save ¥') + lineSave.toFixed(2) : '',
        // Only the flash pill/red styling is flash-specific; a bundle / markdown
        // shows the strikethrough was-price without the "FLASH" badge.
        is_flash: onFlash,
      };
    });
    const savedTotal = flashSavings + bundleSavings + markdownSavings;
    this.setData({
      items: itemRows,
      subtotal: subtotal.toFixed(2),
      savedTotal: savedTotal > 0 ? savedTotal.toFixed(2) : '',
      threshold: t,
      remaining,
      unlocked: remainingRaw <= 0,
      pct: alwaysFree ? 100 : Math.min(100, (subtotal / t) * 100),
      copy: {
        kicker:    this.tx('copy.cart.kicker',       L === 'cn' ? '购物车'                   : 'YOUR BASKET'),
        title:     this.tx('copy.cart.title',        L === 'cn' ? '即将拥有。'                : 'Almost yours.'),
        empty:     this.tx('copy.cart.empty',        L === 'cn' ? '购物车空空如也'           : 'Your basket is empty'),
        checkout:  this.tx('copy.cart.checkout_btn', L === 'cn' ? '结账'                     : 'CHECK OUT'),
      },
    });
  },

  // Resolve the free-shipping threshold for the customer's default-address zone
  // so the cart bar matches checkout (e.g. ¥199 in Tianhe vs the global ¥399).
  // Best-effort: on any failure the bar keeps the global default.
  loadZoneThreshold() {
    let path = '/api/retail/free-shipping-threshold';
    try {
      const id = getApp().globalData.activeAddressId;
      if (id) path += '?address_id=' + encodeURIComponent(id);
    } catch {}
    api.get(path)
      .then((d) => {
        const t = Number(d && d.threshold);
        if (Number.isFinite(t)) {
          this._zoneThreshold = t;
          this.recompute();
        }
      })
      .catch(() => {});
  },

  // Pull current effective prices for the cart from the server (no address /
  // delivery needed) and update the stored unit_prices, so the cart shows the
  // live flash price + savings instead of whatever was frozen at add-time.
  async repriceFromServer() {
    const items = cart.get().items;
    if (!items.length) return;
    const app = getApp();
    if (app && app.authReady) { try { await app.authReady; } catch {} }
    const body = {
      items: items.map(it => ({
        product_id: it.product_id,
        qty: it.qty,
        choices: (it.options || []).map(o => o.choice_id).filter(Boolean),
      })),
    };
    try {
      const resp = await api.post('/api/retail/cart/price', body);
      const data = resp && (resp.data || resp) || {};
      if (Array.isArray(data.lines) && cart.reprice(data.lines)) this.recompute();
    } catch (e) { /* offline / not yet authed — keep the frozen prices */ }
  },

  tx(key, fallback) {
    const v = config.copy(key, this.data.lang);
    return v || fallback;
  },

  incQty(e) {
    const key = e.currentTarget.dataset.key;
    const it = cart.get().items.find(i => i.key === key);
    if (it) cart.setQty(key, it.qty + 1);
  },
  decQty(e) {
    const key = e.currentTarget.dataset.key;
    const it = cart.get().items.find(i => i.key === key);
    if (it) cart.setQty(key, Math.max(1, it.qty - 1));
  },
  removeItem(e) {
    cart.remove(e.currentTarget.dataset.key);
  },
  async goCheckout() {
    if (!this.data.items.length) return;
    const app = getApp();
    // Wait for auth before checking nickname — racing onLaunch's silent
    // login would otherwise pop the "bind your profile" modal to a
    // customer who's already bound.
    if (app.authReady) { try { await app.authReady; } catch {} }
    const c = app.globalData.customer || {};
    if (!c.nickname) {
      // Branded in-page modal instead of wx.showModal so typography (Bear /
      // Toni) and the oat/ink/lime palette match the rest of the cart.
      this.setData({ showBindModal: true });
      return;
    }
    wx.navigateTo({ url: '/pages/checkout/checkout' });
  },
  bindModalCancel() {
    this.setData({ showBindModal: false });
  },
  bindModalConfirm() {
    this.setData({ showBindModal: false });
    wx.navigateTo({ url: '/pages/profile/profile' });
  },
  noop() {},
  goShop() {
    wx.switchTab({ url: '/pages/shop/shop' });
  },
});
