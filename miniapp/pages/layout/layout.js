// Generic CMS-driven page — opens any non-home page composed in /cms.
// Routed via wx.navigateTo({ url: '/pages/layout/layout?page=promotions' }).
// Same data flow as home.js, just keyed by the ?page= param.

const api    = require('../../utils/api');
const cart   = require('../../utils/cart');
const config = require('../../utils/config');

// `about` is now hardcoded at /pages/about/about — not layout-driven.
const ALLOWED = new Set(['promotions', 'categories', 'membership']);
const TITLE_EN = { promotions: 'Promotions', categories: 'Shop', membership: 'Roots Club' };
const TITLE_CN = { promotions: '优惠',        categories: '商品', membership: '会员' };

Page({
  data: {
    page: '',
    layout: [],
    products: [],
    categories: [],
    flashSales: [],
    topProducts: {},
    leaderboards: {},
    polls: [],
    customer: null,
    lang: 'en',
    loading: true,
    emptyTitle: 'Nothing here yet',
    emptySub: '',
  },

  onLoad(query) {
    const requested = (query.page || '').toLowerCase();
    const page = ALLOWED.has(requested) ? requested : 'promotions';
    const app = getApp();
    const L = app.globalData.lang;
    wx.setNavigationBarTitle({
      title: (L === 'cn' ? TITLE_CN : TITLE_EN)[page] || 'Roots',
    });
    this.setData({
      page,
      lang: L,
      customer: app.globalData.customer || null,
      emptyTitle: L === 'cn' ? '暂时空空如也' : 'Nothing here yet',
      emptySub:   L === 'cn' ? '稍后再回来看看 →' : 'Check back soon →',
    });
    this.refresh();
  },

  async onPullDownRefresh() {
    await this.refresh(true);
    wx.stopPullDownRefresh();
  },

  async refresh(force = false) {
    this.setData({ loading: true });
    const app = getApp();
    const hasToken = !!(app?.globalData?.token);
    try {
      const [cfg, prods, cats, flash, polls] = await Promise.all([
        config.load(force),
        api.get('/api/retail/products?limit=100').catch(() => []),
        api.get('/api/retail/categories').catch(() => []),
        api.get('/api/retail/flash-sales').catch(() => []),
        hasToken ? api.get('/api/retail/polls').catch(() => []) : Promise.resolve([]),
      ]);
      const layout = cfg?.[this.data.page]?.layout || [];
      this.setData({
        layout,
        products: Array.isArray(prods) ? prods : prods?.data || [],
        categories: Array.isArray(cats) ? cats : cats?.data || [],
        flashSales: Array.isArray(flash) ? flash : flash?.data || [],
        polls: Array.isArray(polls) ? polls : (polls?.data || []),
        loading: false,
      });
      this._fetchTopProductsFor(layout);
      this._fetchLeaderboardsFor(layout);
    } catch (e) {
      console.warn('[layout:' + this.data.page + '] refresh failed:', e.message);
      this.setData({ loading: false });
    }
  },

  // Same logic as home.js — fetch any top_selling tuples referenced by the
  // current layout and merge into topProducts so the block-renderer can
  // find them by key.
  async _fetchTopProductsFor(layout) {
    const keys = new Set();
    (layout || []).forEach(b => {
      if (b.type !== 'product_grid' || b.source_type !== 'top_selling') return;
      keys.add(`${b.top_channel || 'combined'}|${b.top_window || '7d'}|${b.limit || 6}`);
    });
    if (!keys.size) return;
    const next = { ...(this.data.topProducts || {}) };
    await Promise.all([...keys].map(async key => {
      if (next[key]) return;
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

  // Same lazy pattern for leaderboard blocks — fetch each distinct
  // metric|period|top_n|reveal_mode tuple once from the public storefront
  // endpoint and merge into data.leaderboards.
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
      if (next[key]) return;
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
      console.warn('[layout] vote failed:', err.message);
      wx.showToast({
        title: this.data.lang === 'cn' ? '投票失败' : 'Vote failed',
        icon: 'none', duration: 1800,
      });
    }
  },

  onCta(e) {
    const t = e.detail.target || '';
    if (!t) return;
    if (t === 'shop')        return wx.switchTab({ url: '/pages/shop/shop' });
    if (t === 'cart')        return wx.switchTab({ url: '/pages/cart/cart' });
    if (t === 'me')          return wx.switchTab({ url: '/pages/me/me' });
    if (t === 'home')        return wx.switchTab({ url: '/pages/home/home' });
    if (t === 'membership')  return wx.navigateTo({ url: '/pages/membership/membership' });
    if (t === 'about')       return wx.navigateTo({ url: '/pages/about/about' });
    if (t === 'coupons')     return wx.navigateTo({ url: '/pages/coupons/coupons' });
    if (t === 'wallet')      return wx.navigateTo({ url: '/pages/wallet/wallet' });
    if (t === 'voting')      return wx.navigateTo({ url: '/pages/voting/voting' });
    if (t === 'faq')         return wx.navigateTo({ url: '/pages/faq/faq' });
    if (t === 'affiliate')   return wx.navigateTo({ url: '/pages/affiliate/affiliate' });
    if (t === 'topup')       return wx.navigateTo({ url: '/pages/topup/topup' });
    if (t === 'leaderboard') return wx.navigateTo({ url: '/pages/leaderboard/leaderboard' });
    if (ALLOWED.has(t))      return wx.navigateTo({ url: '/pages/layout/layout?page=' + t });
    if (t.startsWith('product:'))  return wx.navigateTo({ url: '/pages/product/product?id=' + t.split(':')[1] });
    if (t.startsWith('category:')) return wx.switchTab({ url: '/pages/shop/shop' });
  },
  onCategory()   { wx.switchTab({ url: '/pages/shop/shop' }); },
  onProduct(e)   {
    const id = e.detail.id;
    if (id) wx.navigateTo({ url: '/pages/product/product?id=' + id });
  },
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
    wx.showToast({
      title: added > 0
        ? (this.data.lang === 'cn' ? `${added} 件已加入购物车` : `${added} added to cart`)
        : (this.data.lang === 'cn' ? '商品已下架' : 'Items unavailable'),
      icon: added > 0 ? 'success' : 'none',
      duration: 1400,
    });
  },
});
