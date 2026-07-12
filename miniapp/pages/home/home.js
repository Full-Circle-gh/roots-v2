// Home page — reads home.layout from /api/retail/config and renders each
// block via <block-renderer>. Pulls products + categories for blocks that
// need them. Pull-to-refresh re-fetches config in case the office just
// published a layout change.

const api    = require('../../utils/api');
const cart   = require('../../utils/cart');
const config = require('../../utils/config');
const lang   = require('../../utils/lang');
const theme  = require('../../utils/theme');
const { createPoller } = require('../../utils/livepoll');
const fontgate = require('../../utils/fontgate');

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
    // Category/all product_grid rows keyed by `${categoryId||'all'}|${limit}`.
    // Each category-scoped (or source=all) grid fetches its own slice
    // server-side so it isn't capped by the home's first-100 products pull.
    catGrids: {},
    // Handpicked products keyed by id — fetched for the by-id blocks (featured /
    // manual grid / bundle / recipe_story) so a product chosen in the CMS that
    // sorts past the first-100 pull still resolves.
    productsById: {},
    // Customer's latest in-flight order (or null) — feeds the order_tracker
    // block. Only fetched when the layout contains one and the user is authed.
    activeOrder: null,
    affiliate: null,
    polls: [],
    // Live top-up packages — feeds the top_up block's tier row. Auth-gated,
    // so only fetched when the layout has a top_up block and the user is authed.
    topupPackages: [],
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
    // Brand-theme CSS-variable overrides (palette + fonts), injected at the
    // page root so app.wxss tokens adopt the tenant brand. '' = un-themed.
    themeVars: '',
    // False only on the first launch while brand fonts download — gates the
    // hero/content fade-in (utils/fontgate.js) so the wordmark doesn't flash a
    // system font then snap to Bear Serif. True (instant) on cached launches.
    fontsReady: true,
  },

  switchLang(e) {
    const next = e.currentTarget.dataset.lang;
    if (!next || next === this.data.lang) return;
    lang.set(next);
    this.setData({ lang: next });
  },

  onLoad(query) {
    // A shared affiliate card now lands here (not the affiliate page). Stash
    // the ref code so the affiliate apply box can pre-fill it later.
    if (query && query.ref) {
      try { wx.setStorageSync('pending_ref', String(query.ref).toUpperCase().slice(0, 32)); } catch (e) {}
    }
    // Onboarding gating — mode + version come from /api/retail/config
    // (cfg.onboarding.show_to / cfg.onboarding.version, edited in /cms).
    // Storage flag `onboarded` holds the version string the user last
    // finished; mismatch = re-show, missing = brand-new user.
    // Fade brand text in once the brand fonts are ready (first launch only).
    fontgate.gate(this);
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
    const cfg = app.globalData.config || {};
    const surface = cfg.theme && cfg.theme.palette && cfg.theme.palette.surface;
    const bg = surface || theme.getPageBg(app);
    if (bg !== this.data.themeBg) patch.themeBg = bg;
    const tv = theme.buildThemeVars(cfg);
    if (tv !== this.data.themeVars) patch.themeVars = tv;
    if (Object.keys(patch).length) this.setData(patch);
    const tb = this.getTabBar && this.getTabBar();
    if (tb && tb.setSelected) tb.setSelected('pages/home/home');
    // Re-sync the unread-notifications badge whenever Home becomes visible
    // again. Without this the greeting-block strip would stale-render the
    // count from onLoad — e.g. user opens Notifications, reads items,
    // returns to Home, strip still says "3 new updates".
    this._refreshNotifUnread();
    // Re-pull the order-tracker banner so an admin marking the order paid
    // (or shipping it) reflects the moment Home becomes visible again,
    // not only on a manual pull-to-refresh.
    this._fetchActiveOrderFor(this.data.layout);
    // …and keep it live while Home stays on screen.
    if (!this._orderPoller) {
      this._orderPoller = createPoller(() => this._fetchActiveOrderFor(this.data.layout));
    }
    this._orderPoller.start();
  },

  onHide() {
    if (this._orderPoller) this._orderPoller.stop();
  },

  onUnload() {
    if (this._orderPoller) this._orderPoller.stop();
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
      return {
        notifUnread: 0, notifLatestEn: '', notifLatestCn: '', notifHasBroadcast: false, notifIsFresh: false,
        notifNoOrderUnread: 0, notifNoOrderLatestEn: '', notifNoOrderLatestCn: '', notifNoOrderFresh: false,
      };
    }
    // Server stores 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO; "fresh" = arrived
    // within the last 6 hours and drives the icon pulse.
    const isFresh = (raw) => {
      if (!raw) return false;
      const s = String(raw);
      const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
      const t = new Date(iso).getTime();
      return Number.isFinite(t) && (Date.now() - t) < 6 * 60 * 60 * 1000;
    };
    return {
      notifUnread:       res.count || 0,
      notifLatestEn:     res.latest_title_en || '',
      notifLatestCn:     res.latest_title_cn || '',
      notifHasBroadcast: !!res.has_broadcast,
      notifIsFresh:      isFresh(res.latest_created_at),
      // Order/shipping-excluded scope for blocks set to "announcements only".
      notifNoOrderUnread:   res.no_order_count || 0,
      notifNoOrderLatestEn: res.no_order_title_en || '',
      notifNoOrderLatestCn: res.no_order_title_cn || '',
      notifNoOrderFresh:    isFresh(res.no_order_created_at),
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
        // lean=1: home cards render name/price/image/tagline only — never the
        // full rich-HTML description. lean drops it server-side (a 100-row pull
        // was 1.28 MB, 1.2 MB of it descriptions the home throws away → ~80 KB).
        // Keeps this array small enough to thread through every block-renderer
        // without blowing WeChat's setData bridge. PDP still fetches full copy.
        api.get('/api/retail/products?limit=100&lean=1').catch(() => []),
        // counts=1 enriches each top with an accurate full-catalogue product
        // count + cover URL (the category_tabs block reads them) — otherwise it
        // would derive both from the capped products pull and undercount.
        api.get('/api/retail/category-tree?counts=1').catch(() => []),
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
        // Categories now come from the 2-level category tree's TOP nodes (the
        // legacy categories table is gone). Shape each top as { id, name (EN,
        // matches products.category), name_cn } so blocks match + show CN.
        categories: (Array.isArray(cats) ? cats : (cats?.data || []))
          .map(t => ({ id: t.id, name: t.name, name_cn: t.name_cn || '', count: t.count, cover: t.cover || '' })),
        flashSales: Array.isArray(flash) ? flash : (flash?.data || []),
        affiliate: aff || null,
        polls: Array.isArray(polls) ? polls : (polls?.data || []),
        favorites: Array.isArray(favs) ? favs : (favs?.data || []),
        ...notifPatch,
        // Strip background is operator-configurable in retail-admin →
        // Settings → Brand & theme → Notification strip. Empty string
        // means "use the WXSS default".
        notifColor: (cfg && cfg.theme && cfg.theme.notif_color) || '',
        themeBg: (app.globalData.config && app.globalData.config.theme && app.globalData.config.theme.palette && app.globalData.config.theme.palette.surface) || theme.getPageBg(app),
        themeVars: theme.buildThemeVars(app.globalData.config),
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
      // Category / source=all grids fetch their own slice server-side so a
      // category sorting past the first-100 products pull still shows.
      this._fetchCategoryGridsFor(layout);
      // By-id blocks (featured / manual / bundle / recipe_story) fetch their
      // handpicked products by id so a far-sorted pick still resolves.
      this._fetchProductsByIdFor(layout);
      this._fetchActiveOrderFor(layout);
      // Live top-up tiers for any top_up block.
      this._fetchTopupPackagesFor(layout);
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

  // Fetch the live top-up packages once if the layout contains a top_up
  // block. Public storefront endpoint (no auth) so signed-out visitors see
  // the tier row too. Setting topupPackages triggers the block-renderer
  // observer so the tier row fills in place.
  async _fetchTopupPackagesFor(layout) {
    const hasTopUp = (layout || []).some(b => b.type === 'top_up');
    if (!hasTopUp) return;
    if (this.data.topupPackages && this.data.topupPackages.length) return;
    try {
      const res = await api.get('/api/retail/storefront/topup-packages');
      const rows = Array.isArray(res) ? res : (res?.data || []);
      this.setData({ topupPackages: rows });
    } catch {
      /* leave empty — block falls back to heading only */
    }
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
        const res = await api.get(`/api/retail/products?sort=newest&limit=${encodeURIComponent(limit)}&lean=1`);
        next[limit] = Array.isArray(res) ? res : (res?.data || []);
      } catch {
        next[limit] = [];
      }
    }));
    this.setData({ newArrivals: next });
  },

  // Walk the layout for product_grid blocks that source from a category (or
  // 'all' — anything that isn't manual / top_selling / new_arrivals). Each
  // fetches its own slice server-side, keyed by `${categoryId||'all'}|${limit}`,
  // so a category whose products sort past the home's first-100 products pull
  // still appears (the block-renderer would otherwise filter only that capped
  // array). Mirrors _fetchTopProductsFor / _fetchNewArrivalsFor; lean=1 keeps
  // each slice tiny. The /products endpoint filters by category NAME, so we
  // resolve the block's category_id → name via the loaded category tree.
  async _fetchCategoryGridsFor(layout) {
    const specs = new Map();   // key → { categoryId, limit }
    (layout || []).forEach(b => {
      if (b.type !== 'product_grid') return;
      const st = b.source_type;
      if (st === 'manual' || st === 'top_selling' || st === 'new_arrivals') return;
      const limit = b.limit || 6;
      specs.set(`${b.category_id || 'all'}|${limit}`, { categoryId: b.category_id || null, limit });
    });
    if (!specs.size) return;
    const next = { ...(this.data.catGrids || {}) };
    await Promise.all([...specs].map(async ([key, spec]) => {
      if (next[key]) return;   // already loaded this render cycle
      let qs = `lean=1&limit=${encodeURIComponent(spec.limit)}`;
      if (spec.categoryId) {
        const cat = (this.data.categories || []).find(c => c.id === spec.categoryId);
        // Unknown category id (e.g. tree changed since publish) → empty, not all.
        if (!cat || !cat.name) { next[key] = []; return; }
        qs += `&category=${encodeURIComponent(cat.name)}`;
      }
      try {
        const res = await api.get(`/api/retail/products?${qs}`);
        next[key] = Array.isArray(res) ? res : (res?.data || []);
      } catch {
        next[key] = [];
      }
    }));
    this.setData({ catGrids: next });
  },

  // Collect every product id the by-id blocks reference (featured / manual
  // product_grid / bundle incl. its variants / recipe_story) and fetch them in
  // ONE lean call into data.productsById, so a handpicked product that sorts
  // past the home's first-100 products pull still resolves. Skips ids already
  // covered by that pull (the block-renderer falls back to it for those).
  async _fetchProductsByIdFor(layout) {
    const ids = new Set();
    // Bundle products are tracked separately: they must come from the by-id call
    // (with bundle_components=1) even when the main pull already has the row,
    // because that pull omits the "what's inside" components. byId wins in
    // findProductById, so the component-bearing copy always takes precedence.
    const bundleIds = new Set();
    const addId  = v => { const n = Number(v); if (Number.isFinite(n) && n > 0) ids.add(n); };
    const addIds = a => { if (Array.isArray(a)) a.forEach(addId); };
    const addBundleId = v => { const n = Number(v); if (Number.isFinite(n) && n > 0) { ids.add(n); bundleIds.add(n); } };
    (layout || []).forEach(b => {
      if (b.type === 'featured' || b.type === 'recipe_story') addId(b.product_id);
      else if (b.type === 'product_grid' && b.source_type === 'manual') addIds(b.product_ids);
      else if (b.type === 'bundle') {
        addBundleId(b.bundle_product_id);
        addIds(b.product_ids);
        if (Array.isArray(b.variants)) b.variants.forEach(v => {
          if (v) { addBundleId(v.bundle_product_id); addIds(v.product_ids); }
        });
      }
    });
    if (!ids.size) return;
    const have = new Set((this.data.products || []).map(p => p.id));
    const byId = { ...(this.data.productsById || {}) };
    // Fetch: ids not yet resolved anywhere, PLUS any bundle product still
    // missing its components in byId (fall-through copy in `products` lacks them).
    const fetchIds = [...ids].filter(id =>
      (!have.has(id) && !byId[id]) ||
      (bundleIds.has(id) && !(byId[id] && byId[id].bundle_components)));
    if (!fetchIds.length) return;
    try {
      const res = await api.get(`/api/retail/products?lean=1&bundle_components=1&ids=${fetchIds.join(',')}`);
      const rows = Array.isArray(res) ? res : (res?.data || []);
      rows.forEach(p => { byId[p.id] = p; });
      this.setData({ productsById: byId });
    } catch {
      /* leave productsById as-is — blocks fall back to the products array */
    }
  },

  // The order_tracker block shows the customer's latest in-flight order.
  // Only fetch when the layout has one and the user is authed. We follow the
  // single most recent order (orders come back placed_at DESC): if it's still
  // active (unpaid / paid / preparing / dispatched) we show it, otherwise the
  // block hides. We deliberately do NOT fall back to an older still-active
  // order — doing so made the tracker appear to jump backwards (e.g. marking
  // the newest order delivered would resurrect an older "Paid" order).
  async _fetchActiveOrderFor(layout) {
    const wants = (layout || []).some(b => b.type === 'order_tracker');
    if (!wants) return;
    const app = getApp();
    if (!app?.globalData?.token) { this.setData({ activeOrder: null }); return; }
    try {
      const res = await api.get('/api/retail/orders?limit=5');
      const rows = Array.isArray(res) ? res : (res?.data || []);
      const ACTIVE = new Set(['pending_payment', 'paid', 'preparing', 'dispatched']);
      const newest = rows[0];
      // Count ALL active orders so the card can surface a "N orders in
      // progress →" link when the customer has more than one in flight.
      const activeCount = rows.filter(o => ACTIVE.has(o.status)).length;
      this.setData({
        activeOrder: (newest && ACTIVE.has(newest.status)) ? newest : null,
        activeOrderCount: activeCount,
      });
    } catch {
      this.setData({ activeOrder: null, activeOrderCount: 0 });
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
  // A coupon block bound a phone (new-customers-only CTA) and handed back the
  // refreshed customer. Push it into globalData + data so the greeting block
  // and the coupon CTA (needPhone) recompute with the phone now on file.
  onCustomerChanged(e) {
    const customer = e.detail && e.detail.customer;
    if (!customer) return;
    getApp().globalData.customer = customer;
    this.setData({ customer });
  },
  onCategory(e) {
    this._gotoCategory(e.detail && e.detail.id);
  },
  // Stash the tapped category's name so the Shop tab opens pre-selected and
  // scrolled to that section. switchTab can't carry params, so we hand off
  // via globalData and the shop page picks it up in onShow / after refresh.
  _gotoCategory(id) {
    const cat = (this.data.categories || []).find(c => c.id === id);
    if (cat && cat.name) getApp().globalData.pendingCategory = cat.name;
    wx.switchTab({ url: '/pages/shop/shop' });
  },
  onProduct(e) {
    const id = e.detail.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/product/product?id=' + id });
  },

  // Bundle block → preferred path adds the ONE real Bundle product (its fixed
  // price is charged at checkout and component stock is reserved server-side).
  // Legacy path (old blocks not yet repicked): add each loose product at its
  // normal price + stash an auto-apply voucher code for checkout to pick up.
  onBundle(e) {
    const { bundleProductId = null, productIds = [], voucherCode = '' } = e.detail || {};
    const findP = id => (this.data.productsById || {})[id] || (this.data.products || []).find(x => x.id === id);

    // New model: a single bundle product.
    if (bundleProductId) {
      const bp = findP(bundleProductId);
      if (bp) {
        cart.add(bp, 1, []);
        wx.showToast({
          title: this.data.lang === 'cn' ? '套装已加入购物车' : 'Bundle added to cart',
          icon: 'success', duration: 1400,
        });
      } else {
        wx.showToast({
          title: this.data.lang === 'cn' ? '套装已下架' : 'Bundle unavailable',
          icon: 'none',
        });
      }
      return;
    }

    // Legacy loose-list path.
    if (!productIds.length) return;
    let added = 0;
    productIds.forEach(id => {
      const p = findP(id);
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
    if (t === 'orders')     return wx.navigateTo({ url: '/pages/orders/orders' });
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
    if (t.startsWith('category:')) return this._gotoCategory(t.split(':')[1]);
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
      // Office-set custom invite title (admin → Share cards), else the built-in
      // reward-aware default. The code always rides in the path, never the
      // title, so a custom title never breaks attribution.
      const custom = af.share_title && af.share_title[this.data.lang];
      return {
        title: custom || (en
          ? `Get ¥${reward} off your first Roots order — code ${af.code}`
          : `Roots 邀请码 ${af.code} · 首单立减 ¥${reward}`),
        // Land the friend on the storefront Home; onLoad stashes the ref so
        // the affiliate apply box still pre-fills it later.
        path: '/pages/home/home?ref=' + encodeURIComponent(af.code),
        // Custom share picture set by the office (admin → Affiliate), else the
        // bundled default. af.share_image is already an absolute URL.
        imageUrl: af.share_image || '/assets/brand/share-affiliate.png',
      };
    }
    // Office-set Home share card (admin → Share cards). Picture + optional title
    // are already absolute / plain text; fall back to the built-in defaults.
    const sharing = getApp().globalData.config?.sharing || {};
    const img = sharing.home;
    const title = (sharing.homeTitle && sharing.homeTitle[this.data.lang])
      || (this.data.lang === 'cn' ? 'Roots · 植物食物' : 'Roots · plant-forward food');
    return {
      title,
      path: '/pages/home/home',
      ...(img ? { imageUrl: img } : {}),
    };
  },

  onShareTimeline() {
    const af = this.data.affiliate;
    if (af?.enabled && af.code) {
      const reward = Number(af.reward_per_order) || 30;
      const en = this.data.lang === 'en';
      const custom = af.share_title && af.share_title[this.data.lang];
      return {
        title: custom || (en
          ? `¥${reward} off your first Roots order — ${af.code}`
          : `Roots 首单立减 ¥${reward} · ${af.code}`),
        query: 'ref=' + encodeURIComponent(af.code),
      };
    }
    const sharing = getApp().globalData.config?.sharing || {};
    const img = sharing.home;
    const title = (sharing.homeTitle && sharing.homeTitle[this.data.lang])
      || (this.data.lang === 'cn' ? 'Roots · 植物食物' : 'Roots');
    return {
      title,
      ...(img ? { imageUrl: img } : {}),
    };
  },
});
