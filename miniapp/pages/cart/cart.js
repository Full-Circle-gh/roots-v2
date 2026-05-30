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
    copy: { title: 'Almost yours.', kicker: 'YOUR BASKET · 购物车', empty: 'Your basket is empty — shop the garden →', checkout: 'CHECK OUT' },
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
    let flashSavings = 0;
    const itemRows = state.items.map(it => {
      const onFlash = !!it.is_flash && it.regular_price && Number(it.regular_price) > Number(it.unit_price);
      if (onFlash) flashSavings += (Number(it.regular_price) - Number(it.unit_price)) * it.qty;
      return {
        ...it,
        display_name: lang.pick(it.name_en, it.name_cn, L),
        display_size: lang.pickLabel(it.size, L),
        line_total: (it.unit_price * it.qty).toFixed(2),
        regular_total: onFlash ? (it.regular_price * it.qty).toFixed(2) : '',
      };
    });
    this.setData({
      items: itemRows,
      subtotal: subtotal.toFixed(2),
      savedTotal: flashSavings > 0 ? flashSavings.toFixed(2) : '',
      threshold: t,
      remaining,
      unlocked: remainingRaw <= 0,
      pct: alwaysFree ? 100 : Math.min(100, (subtotal / t) * 100),
      copy: {
        kicker:    this.tx('copy.cart.kicker',       L === 'cn' ? '购物车'                   : 'YOUR BASKET · 购物车'),
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
    api.get('/api/retail/free-shipping-threshold')
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
      const L = this.data.lang;
      wx.showModal({
        title: L === 'cn' ? '请先完善资料' : 'Bind your profile first',
        content: L === 'cn'
          ? '结账前需要绑定您的微信昵称与头像。'
          : 'Please bind your WeChat nickname and avatar before checking out.',
        confirmText: L === 'cn' ? '去绑定' : 'Bind now',
        cancelText:  L === 'cn' ? '取消'   : 'Cancel',
        success: (r) => {
          if (r.confirm) wx.navigateTo({ url: '/pages/profile/profile' });
        },
      });
      return;
    }
    wx.navigateTo({ url: '/pages/checkout/checkout' });
  },
  goShop() {
    wx.switchTab({ url: '/pages/shop/shop' });
  },
});
