// Home page — reads home.layout from /api/retail/config and renders each
// block via <block-renderer>. Pulls products + categories for blocks that
// need them. Pull-to-refresh re-fetches config in case the office just
// published a layout change.

const api    = require('../../utils/api');
const cart   = require('../../utils/cart');
const config = require('../../utils/config');
const lang   = require('../../utils/lang');
const theme  = require('../../utils/theme');

Page({
  data: {
    layout: [],
    products: [],
    categories: [],
    flashSales: [],
    // Top-selling lists keyed by `${channel}|${window}|${limit}`. Only the
    // tuples referenced by product_grid blocks with source_type='top_selling'
    // get fetched — usually 0–2 per page.
    topProducts: {},
    // Leaderboard rows keyed by `${metric}|${period}|${top_n}|${reveal_mode}`.
    // Only tuples referenced by `leaderboard` blocks get fetched — usually 0–1.
    leaderboards: {},
    // Newest products keyed by limit (e.g. '6'). Only fetched when a
    // product_grid block sources from 'new_arrivals'.
    newArrivals: {},
    // Customer's latest in-flight order (or null) — feeds the order_tracker
    // block. Only fetched when the layout contains one and the user is authed.
    activeOrder: null,
    affiliate: null,
    polls: [],
    customer: null,   // { nickname, points_balance, ... } — feeds greeting block
    favorites: [],    // customer's saved products — feeds favorites_block
    // Unread notification count — surfaced as a small badge inside the
    // greeting block (top-right). Hydrated in refresh() from
    // /api/retail/notifications/unread-count when the customer is authed.
    notifUnread: 0,
    // Title of the newest unread row; surfaced in the strip when count===1
    // (cheaper UX than "1 new update — go look").
    notifLatestEn: '',
    notifLatestCn: '',
    // Any unread row is category='broadcast' → strip icon flips to 📣.
    notifHasBroadcast: false,
    // Newest unread arrived within the last 6h → strip icon pulses.
    notifIsFresh: false,
    // Operator-configurable strip background colour (theme.notif_color).
    // Empty string lets the WXSS default win.
    notifColor: '',
    lang: 'en',
    loading: true,
    // User-configured page background, set in /cms → Theme picker. Empty
    // string means "use the page-wxss default" (oat). Updated on every
    // onShow + refresh so a publish-then-pull-down sees the new colour.
    themeBg: '',
  },

  switchLang(e) {
    const next = e.currentTarget.dataset.lang;
    if (!next || next === this.data.lang) return;
    lang.set(next);
    this.setData({ lang: next });
  },

  onLoad() {
    // Onboarding gating — mode + version come from /api/retail/config
    // (cfg.onboarding.show_to / cfg.onboarding.version, edited in /cms).
    // Storage flag `onboarded` holds the version string the user last
    // finished; mismatch = re-show, missing = brand-new user.
    this._gateOnboarding().then(redirected => {
      if (redirected) return;
      const app = getApp();
      this.setData({
        lang: app.globalData.lang || 'en',
        customer: app.globalData.customer || null,
      });
      this.refresh();
    });
  },

  async _gateOnboarding() {
    const app = getApp();
    // One gate evaluation per app cold start. Without this, modes like
    // 'always' (and 'version' right after a bump) would re-redirect every
    // time the user finishes onboarding and lands back on Home — infinite
    // loop. globalData lives until the mini-app is evicted by WeChat, so
    // the next cold start naturally gets a fresh chance to gate.
    if (app.globalData._onboardingChecked) return false;
    app.globalData._onboardingChecked = true;

    let stored = '';
    try { stored = wx.getStorageSync('onboarded'); } catch {}
    let mode = 'new';
    let version = '1';
    try {
      const cfg = await config.load();
      const m = cfg?.onboarding?.show_to;
      if (m === 'new' || m === 'version' || m === 'always' || m === 'off') mode = m;
      if (Number.isFinite(cfg?.onboarding?.version)) version = String(cfg.onboarding.version);
    } catch {
      // Config fetch failed — fall back to legacy "new users only" defaults
      // so a flaky network doesn't strand fresh installs without onboarding.
    }
    let shouldRedirect;
    if (mode === 'off')          shouldRedirect = false;
    else if (mode === 'always')  shouldRedirect = true;
    else if (mode === 'version') shouldRedirect = stored !== version;
    else /* 'new' */             shouldRedirect = !stored;
    if (shouldRedirect) {
      // Deferred to setTimeout(0) so the entry page's first frame completes
      // before we reLaunch — otherwise WeChat's perf monitor crashes with
      // "Cannot read property '__subPageFrameEndTime__' of null".
      setTimeout(() => wx.reLaunch({ url: '/pages/onboarding/onboarding' }), 0);
      return true;
    }
    return false;
  },

  onShow() {
    // Sync language + customer (points_balance may have changed since onLoad)
    // in case the user did anything on /me or /wallet.
    const app = getApp();
    const patch = {};
    if (app.globalData.lang !== this.data.lang) patch.lang = app.globalData.lang;
    if (app.globalData.customer !== this.data.customer) patch.customer = app.globalData.customer || null;
    const bg = theme.getPageBg(app);
    if (bg !== this.data.themeBg) patch.themeBg = bg;
    if (Object.keys(patch).length) this.setData(patch);
    const tb = this.getTabBar && this.getTabBar();
    if (tb && tb.setSelected) tb.setSelected('pages/home/home');
    // Re-sync the unread-notifications badge whenever Home becomes visible
    // again. Without this the greeting-block strip would stale-render the
    // count from onLoad — e.g. user opens Notifications, reads items,
    // returns to Home, strip still says "3 new updates".
    this._refreshNotifUnread();
  },

  // Lightweight side-fetch — runs on every onShow without touching the
  // rest of the home payload. Silently 0s on any error (anonymous, network).
  async _refreshNotifUnread() {
    const app = getApp();
    if (!app?.globalData?.token) return;
    try {
      const res = await api.get('/api/retail/notifications/unread-count');
      this.setData(this._buildNotifPatch(res));
    } catch {}
  },

  // Translate the unread-count endpoint's payload into the data shape the
  // greeting-strip props expect. Centralised so refresh() and onShow's
  // side-fetch derive the same fields the same way. "Fresh" = newest
  // unread row arrived within the last 6 hours; drives the icon pulse.
  _buildNotifPatch(res) {
    if (!res || typeof res !== 'object') {
      return { notifUnread: 0, notifLatestEn: '', notifLatestCn: '', notifHasBroadcast: false, notifIsFresh: false };
    }
    let fresh = false;
    if (res.latest_created_at) {
      // Server stores 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO. Normalise to UTC.
      const raw = String(res.latest_created_at);
      const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
      const t = new Date(iso).getTime();
      if (Number.isFinite(t)) fresh = (Date.now() - t) < 6 * 60 * 60 * 1000;
    }
    return {
      notifUnread:       res.count || 0,
      notifLatestEn:     res.latest_title_en || '',
      notifLatestCn:     res.latest_title_cn || '',
      notifHasBroadcast: !!res.has_broadcast,
      notifIsFresh:      fresh,
    };
  },

  async onPullDownRefresh() {
    await this.refresh(true);
    wx.stopPullDownRefresh();
  },

  async refresh(force = false) {
    this.setData({ loading: true });
    // Affiliate is only fetchable when authed — pre-resolves to null if not.
    // Treated as nice-to-have (the home page must still render if it 401s).
    const app = getApp();
    const hasToken = !!(app?.globalData?.token);
    try {
      const [cfg, prods, cats, flash, aff, polls, favs, notif] = await Promise.all([
        config.load(force),
        api.get('/api/retail/products?limit=100').catch(() => []),
        api.get('/api/retail/categories').catch(() => []),
        api.get('/api/retail/flash-sales').catch(() => []),
        hasToken ? api.get('/api/retail/affiliate').catch(() => null) : Promise.resolve(null),
        // Polls feed voting_block in auto-pull mode. Requires auth, so
        // skip on first launch — block will show stub / hide as configured.
        hasToken ? api.get('/api/retail/polls').catch(() => []) : Promise.resolve([]),
        // Favorites feed favorites_block. Authed-only — anonymous users
        // hit the block's empty state (or it auto-hides).
        hasToken ? api.get('/api/retail/favorites').catch(() => []) : Promise.resolve([]),
        // Unread notification count — feeds the greeting block badge.
        // Anonymous users have nothing to count.
        hasToken ? api.get('/api/retail/notifications/unread-count').catch(() => null) : Promise.resolve(null),
      ]);
      const layout = cfg?.home?.layout || [];
      const notifPatch = this._buildNotifPatch(notif);
      this.setData({
        layout,
        products: Array.isArray(prods) ? prods : (prods?.data || []),
        categories: Array.isArray(cats) ? cats : (cats?.data || []),
        flashSales: Array.isArray(flash) ? flash : (flash?.data || []),
        affiliate: aff || null,
        polls: Array.isArray(polls) ? polls : (polls?.data || []),
        favorites: Array.isArray(favs) ? favs : (favs?.data || []),
        ...notifPatch,
        // Strip background is operator-configurable in retail-admin →
        // Settings → Brand & theme → Notification strip. Empty string
        // means "use the WXSS default".
        notifColor: (cfg && cfg.theme && cfg.theme.notif_color) || '',
        themeBg: theme.getPageBg(app),
        loading: false,
      });
      // Fire-and-forget top-seller fetches for any blocks that need them.
      // Setting topProducts after data lands triggers the block-renderer
      // observer and the products appear in place.
      this._fetchTopProductsFor(layout);
      // Same lazy pattern for leaderboard blocks.
      this._fetchLeaderboardsFor(layout);
      // New-arrivals grids + the order tracker fetch on demand too.
      this._fetchNewArrivalsFor(layout);
      this._fetchActiveOrderFor(layout);
    } catch (e) {
      console.warn('[home] refresh failed:', e.message);
      this.setData({ loading: false });
    }
  },

  // Walk the layout looking for product_grid blocks that source from
  // top sellers, build the unique set of (channel|window|limit) tuples,
  // fetch each once, and merge results into data.topProducts.
  async _fetchTopProductsFor(layout) {
    const keys = new Set();
    (layout || []).forEach(b => {
      if (b.type !== 'product_grid' || b.source_type !== 'top_selling') return;
      const key = `${b.top_channel || 'combined'}|${b.top_window || '7d'}|${b.limit || 6}`;
      keys.add(key);
    });
    if (!keys.size) return;
    const next = { ...(this.data.topProducts || {}) };
    await Promise.all([...keys].map(async key => {
      if (next[key]) return;  // already loaded this render cycle
      const [channel, window, limit] = key.split('|');
      try {
        const res = await api.get(`/api/retail/products/top?channel=${encodeURIComponent(channel)}&window=${encodeURIComponent(window)}&limit=${encodeURIComponent(limit)}`);
        next[key] = Array.isArray(res) ? res : (res?.data || []);
      } catch {
        next[key] = [];
      }
    }));
    this.setData({ topProducts: next });
  },

  // Walk the layout for leaderboard blocks, build the unique set of
  // (metric|period|top_n|reveal_mode) tuples, fetch each once from the public
  // storefront endpoint (no auth — anonymous Home viewers see it too), and
  // merge into data.leaderboards. Setting it triggers the block-renderer
  // observer so the ranking strip fills in place.
  async _fetchLeaderboardsFor(layout) {
    const keys = new Set();
    (layout || []).forEach(b => {
      if (b.type !== 'leaderboard') return;
      const metric = b.metric || 'lifetime_spend';
      const period = b.period || 'month';
      const topN   = Math.max(3, Math.min(10, b.top_n || 5));
      const reveal = b.reveal_mode || 'first_char';
      keys.add(`${metric}|${period}|${topN}|${reveal}`);
    });
    if (!keys.size) return;
    const next = { ...(this.data.leaderboards || {}) };
    await Promise.all([...keys].map(async key => {
      if (next[key]) return;  // already loaded this render cycle
      const [metric, period, top_n, reveal_mode] = key.split('|');
      try {
        const res = await api.get(`/api/retail/storefront/leaderboard?metric=${encodeURIComponent(metric)}&period=${encodeURIComponent(period)}&top_n=${encodeURIComponent(top_n)}&reveal_mode=${encodeURIComponent(reveal_mode)}`);
        next[key] = (res && Array.isArray(res.entries)) ? res.entries : [];
      } catch {
        next[key] = [];
      }
    }));
    this.setData({ leaderboards: next });
  },

  // Walk the layout for product_grid blocks sourcing from 'new_arrivals',
  // fetch the newest products once per distinct limit (server sorts by
  // created_at DESC), and merge into data.newArrivals keyed by limit.
  async _fetchNewArrivalsFor(layout) {
    const limits = new Set();
    (layout || []).forEach(b => {
      if (b.type !== 'product_grid' || b.source_type !== 'new_arrivals') return;
      limits.add(String(b.limit || 6));
    });
    if (!limits.size) return;
    const next = { ...(this.data.newArrivals || {}) };
    await Promise.all([...limits].map(async limit => {
      if (next[limit]) return;
      try {
        const res = await api.get(`/api/retail/products?sort=newest&limit=${encodeURIComponent(limit)}`);
        next[limit] = Array.isArray(res) ? res : (res?.data || []);
      } catch {
        next[limit] = [];
      }
    }));
    this.setData({ newArrivals: next });
  },

  // The order_tracker block shows the customer's latest in-flight order.
  // Only fetch when the layout has one and the user is authed; pick the
  // newest order whose status is still active (unpaid / paid / preparing /
  // dispatched). Terminal orders (delivered / cancelled / refunded) leave
  // activeOrder null so the block hides.
  async _fetchActiveOrderFor(layout) {
    const wants = (layout || []).some(b => b.type === 'order_tracker');
    if (!wants) return;
    const app = getApp();
    if (!app?.globalData?.token) { this.setData({ activeOrder: null }); return; }
    try {
      const res = await api.get('/api/retail/orders?limit=5');
      const rows = Array.isArray(res) ? res : (res?.data || []);
      const ACTIVE = new Set(['pending_payment', 'paid', 'preparing', 'dispatched']);
      this.setData({ activeOrder: rows.find(o => ACTIVE.has(o.status)) || null });
    } catch {
      this.setData({ activeOrder: null });
    }
  },

  // Order-tracker tap → open the order detail page.
  onOrder(e) {
    const id = e.detail && e.detail.id;
    if (id) wx.navigateTo({ url: '/pages/order/order?id=' + id });
  },

  // Inline vote cast from a voting_block. Posts the vote and refreshes
  // polls so the result bars + "vote counted" state appear immediately.
  async onVote(e) {
    const { pollId, optionId } = e.detail || {};
    if (!pollId || !optionId) return;
    try {
      const res = await api.post(`/api/retail/polls/${pollId}/vote`, { option_id: optionId });
      const reward = res?.awarded_points || 0;
      if (reward > 0) {
        wx.showToast({
          title: this.data.lang === 'cn' ? `+${reward} 积分` : `+${reward} pts`,
          icon: 'success', duration: 1600,
        });
      }
      const app = getApp();
      if (res?.points_balance != null && app.globalData.customer) {
        app.globalData.customer.points_balance = res.points_balance;
        try { wx.setStorageSync('customer', app.globalData.customer); } catch {}
      }
      const polls = await api.get('/api/retail/polls').catch(() => []);
      this.setData({ polls: Array.isArray(polls) ? polls : (polls?.data || []) });
    } catch (err) {
      console.warn('[home] vote failed:', err.message);
      wx.showToast({
        title: this.data.lang === 'cn' ? '投票失败' : 'Vote failed',
        icon: 'none', duration: 1800,
      });
    }
  },

  // ─── Navigation handlers fired by <block-renderer> events ──────────
  onCta(e) {
    const target = e.detail.target || '';
    this.routeTarget(target);
  },
  onCategory(e) {
    wx.switchTab({ url: '/pages/shop/shop' });
    // TODO: pre-select the tapped category on the shop tab
  },
  onProduct(e) {
    const id = e.detail.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/product/product?id=' + id });
  },

  // Bundle block → add every listed product to cart at its normal price,
  // optionally stash an auto-apply voucher code that the checkout will pick
  // up the next time the user opens it. Backend has no bundle concept, so
  // we keep things truthful by adding items at their real prices.
  onBundle(e) {
    const { productIds = [], voucherCode = '' } = e.detail || {};
    if (!productIds.length) return;
    let added = 0;
    productIds.forEach(id => {
      const p = (this.data.products || []).find(x => x.id === id);
      if (p) { cart.add(p, 1, []); added++; }
    });
    if (voucherCode) {
      try { wx.setStorageSync('pending_voucher_code', voucherCode); } catch {}
    }
    if (added > 0) {
      wx.showToast({
        title: this.data.lang === 'cn'
          ? `${added} 件已加入购物车`
          : `${added} added to cart`,
        icon: 'success',
        duration: 1400,
      });
    } else {
      wx.showToast({
        title: this.data.lang === 'cn' ? '商品已下架' : 'Items unavailable',
        icon: 'none',
      });
    }
  },
  routeTarget(t) {
    if (!t) return;
    // Tab-bar destinations
    if (t === 'shop') return wx.switchTab({ url: '/pages/shop/shop' });
    if (t === 'cart') return wx.switchTab({ url: '/pages/cart/cart' });
    if (t === 'me')   return wx.switchTab({ url: '/pages/me/me' });
    // Standalone pages
    if (t === 'membership') return wx.navigateTo({ url: '/pages/membership/membership' });
    if (t === 'about')      return wx.navigateTo({ url: '/pages/about/about' });
    if (t === 'coupons')    return wx.navigateTo({ url: '/pages/coupons/coupons' });
    if (t === 'wallet')     return wx.navigateTo({ url: '/pages/wallet/wallet' });
    if (t === 'voting')     return wx.navigateTo({ url: '/pages/voting/voting' });
    if (t === 'faq')        return wx.navigateTo({ url: '/pages/faq/faq' });
    if (t === 'affiliate')  return wx.navigateTo({ url: '/pages/affiliate/affiliate' });
    if (t === 'topup')      return wx.navigateTo({ url: '/pages/topup/topup' });
    if (t === 'favorites')  return wx.navigateTo({ url: '/pages/favorites/favorites' });
    if (t === 'leaderboard') return wx.navigateTo({ url: '/pages/leaderboard/leaderboard' });
    if (t === 'notifications') {
      // Tapping the strip is the dismissal action — zero the badge locally
      // and mark every unread notification read on the backend (best-effort)
      // so coming back to Home doesn't re-show the same count.
      if (this.data.notifUnread > 0) {
        this.setData({ notifUnread: 0 });
        api.post('/api/retail/notifications/read-all').catch(() => {});
      }
      return wx.navigateTo({ url: '/pages/notifications/notifications' });
    }
    // Generic CMS-driven pages — same renderer as home, just different layout
    if (t === 'promotions' || t === 'categories') {
      return wx.navigateTo({ url: '/pages/layout/layout?page=' + t });
    }
    // Targeted refs
    if (t.startsWith('product:'))  return wx.navigateTo({ url: '/pages/product/product?id=' + t.split(':')[1] });
    if (t.startsWith('category:')) return wx.switchTab({ url: '/pages/shop/shop' });
  },

  // Page-level share — triggered by `<button open-type="share">` inside any
  // block (currently the affiliate block). When the customer has a referral
  // code, the share carries it in the path so the friend lands on the
  // affiliate page with the code pre-filled. Otherwise, generic store share.
  onShareAppMessage() {
    const af = this.data.affiliate;
    if (af?.enabled && af.code) {
      const reward = Number(af.reward_per_order) || 30;
      const en = this.data.lang === 'en';
      return {
        title: en
          ? `Get ¥${reward} off your first Roots order — code ${af.code}`
          : `Roots 邀请码 ${af.code} · 首单立减 ¥${reward}`,
        path: '/pages/affiliate/affiliate?ref=' + encodeURIComponent(af.code),
        imageUrl: '/assets/brand/share-affiliate.png',
      };
    }
    return {
      title: this.data.lang === 'cn' ? 'Roots · 植物食物' : 'Roots · plant-forward food',
      path: '/pages/home/home',
    };
  },

  onShareTimeline() {
    const af = this.data.affiliate;
    if (af?.enabled && af.code) {
      const reward = Number(af.reward_per_order) || 30;
      const en = this.data.lang === 'en';
      return {
        title: en
          ? `¥${reward} off your first Roots order — ${af.code}`
          : `Roots 首单立减 ¥${reward} · ${af.code}`,
        query: 'ref=' + encodeURIComponent(af.code),
      };
    }
    return { title: this.data.lang === 'cn' ? 'Roots · 植物食物' : 'Roots' };
  },
});
