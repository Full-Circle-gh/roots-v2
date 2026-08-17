// Cart tab — reads local cart state. Editable qty steppers + delete.
// Free-shipping bar is served by /api/retail/free-shipping-threshold, which
// names the zone its figure applies to and says whether that zone has a free
// state at all. The bar never asserts free shipping it can't guarantee.

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
    // Which of the three bar states to render:
    //   'zone'    — we know the area; name it and promise against its target
    //   'policy'  — no address resolved; state the store threshold, promise
    //               nothing, never show "unlocked"
    //   'none'    — the engine gives this zone no free-shipping state, or we
    //               have no figure at all; the bar doesn't render
    shipState: 'none',
    shipZoneName: '',
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
    // The free-shipping bar's figure, its zone name and whether that zone has
    // a free state at all. Until this lands the bar shows nothing.
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
    // Free-shipping figure + which state the bar is in. Both come from the
    // server (loadZoneThreshold), because only the server can match the zone
    // and ask the pricing engine whether a free state exists at all. No local
    // default: with nothing fetched we say nothing rather than guess a number
    // checkout won't honour — the cart promising free shipping the zone then
    // refuses is the whole defect this closes.
    const known = this._ship || null;
    const t = known ? Number(known.threshold) || 0 : 0;
    // An unnamed zone can't be named, so it can't carry a promise — it falls
    // back to the policy line like any other unknown address.
    const zoneName = !known || !known.zone ? ''
      : (L === 'cn' ? (known.zone.name_cn || known.zone.name_en || '')
                    : (known.zone.name_en || known.zone.name_cn || ''));
    let shipState;
    if (!known)                shipState = 'none';    // nothing fetched yet
    else if (known.zone)       shipState = known.reachable && zoneName ? 'zone' : 'none';
    else if (t > 0)            shipState = 'policy';  // no address → store line
    else                       shipState = 'none';    // no address, no figure
    // Only a named zone may report "unlocked" — the policy line is a statement
    // about the store, not about her address, so it never fills or completes.
    const alwaysFree = shipState === 'zone' && t <= 0;
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
      shipState,
      shipZoneName: shipState === 'zone' ? zoneName : '',
      // "Unlocked" is a promise, so only the named-zone state may make it.
      unlocked: shipState === 'zone' && remainingRaw <= 0,
      // The policy line carries no progress — it isn't measuring her cart
      // against her zone, so a filling bar would imply a promise it can't keep.
      pct: shipState !== 'zone' ? 0
         : alwaysFree ? 100
         : Math.min(100, (subtotal / t) * 100),
      copy: {
        kicker:    this.tx('copy.cart.kicker',       L === 'cn' ? '购物车'                   : 'YOUR BASKET'),
        title:     this.tx('copy.cart.title',        L === 'cn' ? '即将拥有。'                : 'Almost yours.'),
        empty:     this.tx('copy.cart.empty',        L === 'cn' ? '购物车空空如也'           : 'Your basket is empty'),
        checkout:  this.tx('copy.cart.checkout_btn', L === 'cn' ? '结账'                     : 'CHECK OUT'),
      },
    });
  },

  // Resolve the free-shipping figure for the address the order would actually
  // go to, plus the name of the zone it belongs to and whether that zone has a
  // free-shipping state at all (the server asks the pricing engine, so the bar
  // and the charge can't drift). Best-effort: on any failure `_ship` stays
  // unset and the bar renders nothing rather than a number checkout won't
  // honour — silence is the only honest fallback here.
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
