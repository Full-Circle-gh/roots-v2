// Pending reviews — per-item list of delivered products the customer still
// needs to review. Opened from the Review bucket on the Me tab. Reads
// /api/retail/reviews/pending.

const api  = require('../../utils/api');
const lang = require('../../utils/lang');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return api.BASE + u;
  return u;
}

function formatDeliveredDate(iso, L) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  if (L === 'cn') return `${d.getMonth() + 1}月${d.getDate()}日 已送达`;
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `DELIVERED ${months[d.getMonth()]} ${d.getDate()}`;
}

Page({
  data: {
    items: [],
    loading: true,
    lang: 'en',
    copy: {
      title: 'Pending reviews',
      subtitle: 'Items waiting for your take.',
      empty: 'All caught up — nothing waiting for a review.',
      cta: 'Write review →',
      orderLabel: 'ORDER',
    },
  },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.applyLangCopy();
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  applyLangCopy() {
    if (this.data.lang !== 'cn') return;
    this.setData({
      copy: {
        title: '待评价',
        subtitle: '这些商品还在等您的反馈。',
        empty: '全部完成 — 暂无待评价的商品。',
        cta: '写评价 →',
        orderLabel: '订单',
      },
    });
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }
    if (!app.globalData.token) {
      this.setData({ loading: false });
      return;
    }
    this.setData({ loading: true });
    try {
      const list = await api.get('/api/retail/reviews/pending');
      const arr = Array.isArray(list) ? list : (list?.data || []);
      const L = this.data.lang;
      const items = arr.map(it => ({
        ...it,
        // Stable composite key for wx:for — the same product can be pending
        // from two different orders, so product_id alone isn't unique.
        _key: `${it.order_id}-${it.product_id}`,
        display_name: lang.pick(it.name_en, it.name_cn, L),
        image: absUrl(it.image_url) || '',
        delivered_label: formatDeliveredDate(it.delivered_at, L),
      }));
      this.setData({ items, loading: false });
    } catch (e) {
      console.warn('[pending-reviews] refresh failed:', e.message);
      this.setData({ loading: false });
    }
  },

  writeReview(e) {
    const ds = e.currentTarget.dataset;
    const qp = [
      'product_id=' + ds.productId,
      'order_id=' + ds.orderId,
      'product_name=' + encodeURIComponent(ds.name || ''),
      'product_image=' + encodeURIComponent(ds.image || ''),
      'qty=' + (parseInt(ds.qty, 10) || 1),
      'order_no=' + encodeURIComponent(ds.orderNo || ''),
      'delivered_at=' + encodeURIComponent(ds.deliveredAt || ''),
    ].join('&');
    wx.navigateTo({ url: '/pages/review/review?' + qp });
  },
});
