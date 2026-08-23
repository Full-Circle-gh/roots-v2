// Cart tab — reads local cart state. Editable qty steppers + delete.
// The free-shipping bar shows the gap to free delivery against the DELIVERY
// ZONE's own threshold, so the figure agrees with what checkout will charge —
// a Shenzhen address reads Shenzhen's number, not the store-wide default. The
// zone comes from /api/retail/free-shipping-threshold, which resolves the
// address checkout last used, else the default saved one; the store-wide
// figure stands in only when no address resolves, and where the resolved zone
// has no free-shipping state at all the bar renders nothing.

const cart   = require('../../utils/cart');
const config = require('../../utils/config');
const lang   = require('../../utils/lang');
const api    = require('../../utils/api');
const optionText = require('../../utils/options');

Page({
  data: {
    items: [],
    subtotal: 0,
    savedTotal: '',
    threshold: 0,
    remaining: 0,
    unlocked: false,
    pct: 0,
    // Two states only:
    //   'bar'    — show the gap + progress fill against `threshold`.
    //   'none'   — the resolved zone has no free-shipping state, or we have no
    //              figure yet; the bar doesn't render.
    shipState: 'none',
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
    // Copy overrides + theme; the bar's own numbers no longer come from here.
    config.load().then(() => this.recompute()).catch(() => {});
    // The free-shipping bar's figure for the resolved delivery zone, and
    // whether that zone has a free state at all. Until this lands, no bar.
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
    // The free-shipping figure, from the server (loadZoneThreshold): the
    // resolved zone's own threshold where an address resolved, the store-wide
    // one where none did. Round the gap UP so the bar never understates what's
    // left, and clamp the fill at 100% — same arithmetic as public/shop.html.
    const known = this._ship || null;
    const t = known ? Number(known.threshold) || 0 : 0;
    // t <= 0 with a figure fetched means the store charges no delivery at all.
    const alwaysFree = !!known && t <= 0;
    const remainingRaw = alwaysFree ? 0 : Math.max(0, t - subtotal);
    const remaining = Math.ceil(remainingRaw);
    let shipState;
    if (!known)                              shipState = 'none'; // nothing fetched
    else if (known.zone && !known.reachable) shipState = 'none'; // no free state here
    else                                     shipState = 'bar';
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
        // Chosen options (e.g. dressing), each as "Question: Answer". Names and
        // labels were localised at add-time; rows added before the name was
        // carried fall back to the bare answer.
        display_options: optionText.format(it.options, L),
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
      unlocked: alwaysFree || remainingRaw <= 0,
      pct: alwaysFree ? 100 : Math.min(100, (subtotal / t) * 100),
      shipState,
      copy: {
        kicker:    this.tx('copy.cart.kicker',       L === 'cn' ? '购物车'                   : 'YOUR BASKET'),
        title:     this.tx('copy.cart.title',        L === 'cn' ? '即将拥有。'                : 'Almost yours.'),
        empty:     this.tx('copy.cart.empty',        L === 'cn' ? '购物车空空如也'           : 'Your basket is empty'),
        checkout:  this.tx('copy.cart.checkout_btn', L === 'cn' ? '结账'                     : 'CHECK OUT'),
      },
    });
  },

  // Fetch the free-shipping figure the bar prices against, plus whether the
  // zone the server resolved has any free-shipping state at all.
  //
  // `threshold` is the resolved zone's own number (the store-wide one only
  // where no address resolved), so the bar and checkout quote the same figure —
  // a Shenzhen address reads Shenzhen's. We send activeAddressId so the server
  // resolves the same address checkout would; it falls back to the default
  // saved one. `reachable` is false where the pricing engine will never hand
  // this zone a ¥0 delivery line, and then the bar renders nothing at all.
  //
  // Best-effort: on any failure `_ship` stays unset and the bar renders nothing.
  // Silence is the only honest fallback — there is no local default to fall to.
  loadZoneThreshold() {
    let path = '/api/retail/free-shipping-threshold';
    try {
      const id = getApp().globalData.activeAddressId;
      if (id) path += '?address_id=' + encodeURIComponent(id);
    } catch {}
    api.get(path)
      .then((d) => {
        if (!d || !Number.isFinite(Number(d.threshold))) return;
        this._ship = {
          threshold: Number(d.threshold),
          zone: d.zone || null,
          reachable: !!d.reachable,
        };
        this.recompute();
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
