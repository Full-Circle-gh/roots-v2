// Cart tab — reads local cart state. Editable qty steppers + delete.
// Free-shipping bar pulls the threshold from config.fees.freeShippingThreshold.

const cart   = require('../../utils/cart');
const config = require('../../utils/config');
const lang   = require('../../utils/lang');

Page({
  data: {
    items: [],
    subtotal: 0,
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
    const threshold = config.copy ? 399 : 399;  // placeholder
    let configFees = 399, std = 12;
    try {
      const c = require('../../utils/config');
      const cached = c.load(false).catch(() => null);
      // Synchronous-ish: rely on whatever's cached without awaiting
    } catch {}
    const t = 399;  // TODO: read from config.fees.freeShippingThreshold
    // Round UP to the next whole ¥ so the displayed gap never *understates*
    // what's needed (¥146.39999… → ¥147). Subtotal can be fractional from
    // discounts, but the cart bar reads cleaner as a round number.
    const remainingRaw = Math.max(0, t - subtotal);
    const remaining = Math.ceil(remainingRaw);
    this.setData({
      items: state.items.map(it => ({
        ...it,
        display_name: lang.pick(it.name_en, it.name_cn, L),
        line_total: (it.unit_price * it.qty).toFixed(2),
        regular_total: it.is_flash && it.regular_price ? (it.regular_price * it.qty).toFixed(2) : '',
      })),
      subtotal: subtotal.toFixed(2),
      threshold: t,
      remaining,
      unlocked: remainingRaw <= 0,
      pct: Math.min(100, (subtotal / t) * 100),
      copy: {
        kicker:    this.tx('copy.cart.kicker',       L === 'cn' ? '购物车'                   : 'YOUR BASKET · 购物车'),
        title:     this.tx('copy.cart.title',        L === 'cn' ? '即将拥有。'                : 'Almost yours.'),
        empty:     this.tx('copy.cart.empty',        L === 'cn' ? '购物车空空如也'           : 'Your basket is empty'),
        checkout:  this.tx('copy.cart.checkout_btn', L === 'cn' ? '结账'                     : 'CHECK OUT'),
      },
    });
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
