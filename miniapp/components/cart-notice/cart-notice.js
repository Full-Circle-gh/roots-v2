// Add-to-cart notice — the tenant's own warning about a product, raised the
// moment that product goes into the cart. "This kombucha is alive; stand it in
// the fridge overnight before you open it."
//
// WHAT IT IS NOT, because two neighbours look like it. popup-manager shows the
// CAMPAIGN pop-ups (`popups.list`) — page-scoped, scheduled, and blind to what
// is being bought. The checkout's bn-card notices are computed from the whole
// CART and speak about delivery. This one belongs to the product and fires on
// the gesture.
//
// THE COMPONENT OWNS NO COPY AND NO RULES. Which notice a product carries is
// decided once, on the server (`cart_notice` on the product payload); whether a
// customer has already met it is decided once, in utils/cart-notice.js. This
// file is the card and nothing else, so there is no second place for the two
// questions to be answered differently.
//
// IT DRAINS A QUEUE RATHER THAN SHOWING "THE" NOTICE, for the reason §196 gave
// the checkout: a second card that arrives while the first is up must wait, not
// land on top of it and bury it. Adding two flagged products in a row is the
// ordinary way that happens here.
const cartNotice = require('../../utils/cart-notice');
const lang = require('../../utils/lang');

Component({
  data: {
    open: false,
    // The confirmation line the page would otherwise have toasted ("Added to
    // cart"). Handed to showNext() by the caller rather than composed here: the
    // product page says something different for a pre-order than for an
    // in-stock add (§108), and the card must not be the surface that starts
    // disagreeing with the band the customer just tapped. A card that drains
    // the queue by itself — one queued on another screen — has no gesture
    // behind it and shows none.
    kicker: '',
    title: '',
    body: '',
    cta: 'Got it',
  },

  lifetimes: {
    attached() {
      this._lang = getApp()?.globalData?.lang || 'en';
      this.setData({ cta: this._lang === 'cn' ? '知道了' : 'Got it' });
      // A notice queued on another page (a + from the grid, a favourite added
      // from the favourites tab) has nowhere to show until a screen carrying
      // this component appears. Drain on arrival so it is late rather than lost.
      this.showNext();
      this._off = cartNotice.onQueued(() => { if (!this.data.open) this.showNext(); });
    },
    detached() {
      if (this._off) { try { this._off(); } catch (e) { /* listener already gone */ } }
    },
  },

  pageLifetimes: {
    // Re-reads the language on every return to the page: the toggle lives in
    // Me, so a customer can change it between the add and the card.
    show() {
      this._lang = getApp()?.globalData?.lang || 'en';
      if (!this.data.open) this.showNext();
    },
  },

  methods: {
    // Pull the next unseen notice and render it. Returns true when a card went
    // up — the product page reads that to hold its navigate-back until the
    // customer has actually closed it.
    showNext(kicker) {
      const n = cartNotice.takeNext();
      if (!n) return false;
      const L = this._lang;
      // lang.pick falls back to the other language when the chosen one is
      // empty, which is the behaviour this card wants: a tenant who wrote the
      // notice in Chinese alone has still written a notice, and a blank card is
      // a worse answer than the other language's words. Same helper the
      // campaign pop-ups use, so the two cards never start disagreeing.
      const title = lang.pick(n.title_en, n.title_cn, L);
      const body  = lang.pick(n.body_en,  n.body_cn,  L);
      if (!title && !body) return this.showNext(kicker);
      this.setData({
        open: true, title, body,
        kicker: typeof kicker === 'string' ? kicker : '',
        cta: L === 'cn' ? '知道了' : 'Got it',
      });
      return true;
    },

    onClose() {
      this.setData({ open: false });
      // Next in the queue, if the same gesture raised two. Nothing waiting →
      // tell the page, which may have a navigation of its own parked on this.
      if (this.showNext()) return;
      this.triggerEvent('closed');
    },

    // The backdrop swallows taps; the card swallows them again so a tap on the
    // text does not close through it.
    noop() {},
  },
});
