// Favorites — saved / wishlisted products. Mirrors design NO. 21.
// Two views (grid / list), category chips that filter by product.category,
// sticky bottom bar to add all in-stock items to the cart in one tap.

const api  = require('../../utils/api');
const cart = require('../../utils/cart');
const lang = require('../../utils/lang');

const COPY_EN = {
  kicker: 'FAVORITES',
  title: 'Your saved.',
  itemsWord: 'ITEMS',
  itemWord:  'ITEM',
  sortRecent: 'SORT: RECENT',
  emptyTitle: 'Nothing here yet.',
  emptySub:   'Tap the heart on any product to save it.',
  inStockKicker: 'IN STOCK',
  addAll: 'ADD ALL TO CART',
  soldOut: 'SOLD OUT',
  preorder: 'PRE-ORDER',
  catAll: 'ALL',
  toastAddedAll: 'Added to cart',
  toastRemoved: 'Removed',
};

const COPY_CN = {
  kicker: '收藏夹',
  title: '我的收藏。',
  itemsWord: '件',
  itemWord:  '件',
  sortRecent: '最近收藏',
  emptyTitle: '暂无收藏',
  emptySub:   '在商品页点心形图标即可收藏。',
  inStockKicker: '可购买',
  addAll: '全部加入购物车',
  soldOut: '已售罄',
  preorder: '可预订',
  catAll: '全部',
  toastAddedAll: '已加入购物车',
  toastRemoved: '已取消收藏',
};

function fmtSavedDate(s, L) {
  if (!s) return '';
  // sqlite "YYYY-MM-DD HH:MM:SS" → "May 14" / "5月14日"
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return '';
  const m = d.getUTCMonth(); // 0–11
  const day = d.getUTCDate();
  if (L === 'cn') return (m + 1) + '月' + day + '日';
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return months[m] + ' ' + (day < 10 ? '0' + day : day);
}

Page({
  data: {
    lang: 'en',
    copy: COPY_EN,
    loading: false,
    all: [],          // raw favorites
    visible: [],      // after category filter
    cats: [],         // [{ id, label }]
    activeCat: 'All',
    view: 'grid',
    totalCount: 0,
    inStockCount: 0,
    inStockTotal: 0,  // sum of in-stock prices, formatted
  },

  onShow() {
    const app = getApp();
    const L = app.globalData.lang || 'en';
    this.setData({ lang: L });
    wx.setNavigationBarTitle({ title: L === 'cn' ? '收藏夹' : 'Favorites' });
    this.applyLangCopy();
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  applyLangCopy() {
    this.setData({ copy: this.data.lang === 'cn' ? COPY_CN : COPY_EN });
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }
    if (!app.globalData.token) {
      // No auth → empty state. Component still renders.
      this.setData({ all: [], visible: [], cats: [{ id: 'All', label: this.data.copy.catAll }], totalCount: 0, inStockCount: 0 });
      return;
    }
    this.setData({ loading: true });
    try {
      const rows = await api.get('/api/retail/favorites').catch(() => []);
      const list = Array.isArray(rows) ? rows : (rows?.data || []);
      this.setData({ all: list, totalCount: list.length, loading: false });
      this.rebuildView();
    } catch (e) {
      console.warn('[favorites] refresh failed:', e.message);
      this.setData({ loading: false });
    }
  },

  rebuildView() {
    const L = this.data.lang;
    const all = this.data.all || [];
    const copy = this.data.copy;

    // Build category chips from actual data + "All" head.
    const catSet = new Set();
    all.forEach(p => { if (p.category) catSet.add(p.category); });
    const cats = [{ id: 'All', label: copy.catAll }];
    [...catSet].sort().forEach(c => cats.push({ id: c, label: String(c).toUpperCase() }));

    const activeCat = catSet.has(this.data.activeCat) || this.data.activeCat === 'All'
      ? this.data.activeCat : 'All';

    const filtered = activeCat === 'All' ? all : all.filter(p => p.category === activeCat);

    const visible = filtered.map(p => {
      const eff   = Number(p.effective_price) > 0 ? Number(p.effective_price) : Number(p.price) || 0;
      const reg   = Number(p.price) || 0;
      const flash = !!p.is_on_flash && eff < reg;
      // Out of stock but pre-orderable (out-of-city) → stays quick-addable with
      // a PRE-ORDER tag; only a hard-out favourite goes dead. Mirrors the shop.
      const out = p.ship_from_supplier ? !!p.supplier_paused : (p.stock != null && Number(p.stock) <= 0);
      const preorder = out && !p.ship_from_supplier && !!p.oos_preorder;
      const soldOut = out && !preorder;
      const priceDrop = flash && reg > eff ? Math.round(reg - eff) : 0;
      const name = L === 'cn' ? (p.name_cn || p.name_en) : (p.name_en || p.name_cn);
      const cnSub = L === 'cn' ? (p.name_en || '') : (p.name_cn || '');
      const sizeBit = p.size ? p.size : '';
      const subLine = [cnSub, sizeBit].filter(Boolean).join(' · ');
      return {
        id: p.id,
        image: p.image_url || p.image_data || '',
        name,
        subLine,
        priceDisplay: '¥' + Math.round(eff),
        savedDisplay: (L === 'cn' ? '收藏于 ' : 'SAVED ') + fmtSavedDate(p.favorited_at, L),
        soldOut,
        preorder,
        priceDrop,
        priceN: eff,
        product: p,
      };
    });

    // "IN STOCK" total / add-all stays literal: a pre-orderable favourite is
    // quick-addable on its own, but isn't swept into a bulk add.
    const inStock = visible.filter(v => !v.soldOut && !v.preorder);
    const inStockCount = inStock.length;
    const inStockTotal = inStock.reduce((s, v) => s + (v.priceN || 0), 0);

    this.setData({
      cats,
      activeCat,
      visible,
      inStockCount,
      inStockTotal: '¥' + Math.round(inStockTotal),
    });
  },

  onCatTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.activeCat) return;
    this.setData({ activeCat: id });
    this.rebuildView();
  },

  onViewTap(e) {
    const v = e.currentTarget.dataset.view;
    if (v === this.data.view) return;
    this.setData({ view: v });
  },

  onProductTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/product/product?id=' + id });
  },

  // Heart pip on a tile = un-favorite (already on this page = already saved).
  async onUnfavorite(e) {
    e.stopPropagation && e.stopPropagation();
    const id = parseInt(e.currentTarget.dataset.id, 10);
    if (!id) return;
    // Optimistic remove from the list — re-fetch in the background.
    const all = (this.data.all || []).filter(p => p.id !== id);
    this.setData({ all, totalCount: all.length });
    this.rebuildView();
    try {
      await api.del('/api/retail/favorites/' + id);
      wx.showToast({ title: this.data.copy.toastRemoved, icon: 'none', duration: 1000 });
    } catch (err) {
      console.warn('[favorites] remove failed:', err.message);
      // Re-fetch to recover from any optimistic drift.
      this.refresh();
    }
  },

  onQuickAdd(e) {
    e.stopPropagation && e.stopPropagation();
    const id = parseInt(e.currentTarget.dataset.id, 10);
    if (!id) return;
    const p = (this.data.all || []).find(x => x.id === id);
    if (!p) return;
    const out = p.ship_from_supplier ? !!p.supplier_paused : (p.stock != null && Number(p.stock) <= 0);
    const preorder = out && !p.ship_from_supplier && !!p.oos_preorder;
    if (out && !preorder) {
      wx.showToast({ title: this.data.copy.soldOut, icon: 'none' });
      return;
    }
    // Has customer choices (e.g. a dressing) → open the product page to choose
    // instead of quick-adding without them.
    if (p.has_options) {
      wx.navigateTo({ url: '/pages/product/product?id=' + id });
      return;
    }
    cart.add(p, 1, []);
    wx.showToast({
      title: preorder
        ? (this.data.lang === 'cn' ? '已预订，加入购物车' : 'Added — pre-order')
        : (this.data.lang === 'cn' ? '已加入购物车' : 'Added'),
      icon: preorder ? 'none' : 'success',
      duration: preorder ? 1500 : 900,
    });
  },

  onAddAll() {
    const inStock = (this.data.visible || []).filter(v => !v.soldOut && !v.preorder);
    if (!inStock.length) return;
    inStock.forEach(v => cart.add(v.product, 1, []));
    wx.showToast({
      title: this.data.copy.toastAddedAll,
      icon: 'success', duration: 1200,
    });
  },
});
