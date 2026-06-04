// Orders list — customer's order history with filter chips.
// Reads /api/retail/orders (authed, scoped to req.customer.id server-side).

const api  = require('../../utils/api');
const lang = require('../../utils/lang');
const { createPoller } = require('../../utils/livepoll');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return api.BASE + u;
  return u;
}

const STATUS_LABELS_EN = {
  pending_payment: 'Awaiting payment',
  paid:            'Paid',
  preparing:       'Preparing',
  dispatched:      'On the way',
  delivered:       'Delivered',
  cancelled:       'Cancelled',
  refunded:        'Refunded',
};
const STATUS_LABELS_CN = {
  pending_payment: '待支付',
  paid:            '已支付',
  preparing:       '准备中',
  dispatched:      '配送中',
  delivered:       '已送达',
  cancelled:       '已取消',
  refunded:        '已退款',
};

Page({
  data: {
    orders: [],
    activeFilter: '',  // '' = all, or one of the status keys
    lang: 'en',
    loading: true,
    filters: [],
    emptyTitle: 'No orders yet',
    emptySub: 'Once you place an order, it shows up here.',
  },

  onLoad(options) {
    const app = getApp();
    const VALID = new Set(['pending_payment','paid','preparing','dispatched','delivered','cancelled','refunded']);
    // Treat 'to_review' as 'delivered' since reviewable orders are delivered ones.
    const raw = (options && options.status) || '';
    const initial = raw === 'to_review' ? 'delivered' : (VALID.has(raw) ? raw : '');
    this.setData({ lang: app.globalData.lang, activeFilter: initial });
    this.applyLangCopy();
    this.refresh();
  },

  onShow() {
    const app = getApp();
    if (app.globalData.lang !== this.data.lang) {
      this.setData({ lang: app.globalData.lang });
      this.applyLangCopy();
    }
    this.refresh();
    // Keep the list live while it's on screen so status chips advance as the
    // admin works the orders, without the user backing out and re-entering.
    if (!this._orderPoller) {
      this._orderPoller = createPoller(() => this.refresh(true));
    }
    this._orderPoller.start();
  },

  onHide() {
    if (this._orderPoller) this._orderPoller.stop();
  },

  onUnload() {
    if (this._orderPoller) this._orderPoller.stop();
  },

  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  applyLangCopy() {
    const L = this.data.lang;
    const labels = L === 'cn' ? STATUS_LABELS_CN : STATUS_LABELS_EN;
    const filters = [
      { key: '',                 label: L === 'cn' ? '全部'      : 'All'      },
      { key: 'pending_payment',  label: labels.pending_payment              },
      { key: 'paid',             label: labels.paid                          },
      { key: 'preparing',        label: labels.preparing                     },
      { key: 'dispatched',       label: labels.dispatched                    },
      { key: 'delivered',        label: labels.delivered                     },
    ];
    this.setData({
      filters,
      emptyTitle: L === 'cn' ? '暂无订单' : 'No orders yet',
      emptySub:   L === 'cn' ? '下单后会显示在这里。' : 'Once you place an order, it shows up here.',
    });
  },

  async refresh(silent = false) {
    if (!silent) this.setData({ loading: true });
    try {
      const qs = this.data.activeFilter ? '?status=' + this.data.activeFilter : '';
      const list = await api.get('/api/retail/orders' + qs);
      const arr = Array.isArray(list) ? list : list?.data || [];
      const labels = this.data.lang === 'cn' ? STATUS_LABELS_CN : STATUS_LABELS_EN;
      const orders = arr.map(o => ({
        ...o,
        status_label: labels[o.status] || o.status,
        is_pickup: o.fulfillment_type === 'pickup',
        pickup_label: this.data.lang === 'cn' ? '🏬 自提' : '🏬 Pickup',
        total_display: '¥' + Number(o.total || 0).toFixed(2),
        placed_short: (o.placed_at || '').slice(0, 16),
        item_thumbs: (o.items_preview || []).slice(0, 3).map(it => ({
          ...it,
          image: absUrl(it.image_url) || '',
        })),
      }));
      this.setData({ orders, loading: false });
    } catch (e) {
      console.warn('[orders] refresh failed:', e.message);
      this.setData({ loading: false });
    }
  },

  setFilter(e) {
    const key = e.currentTarget.dataset.key || '';
    if (key === this.data.activeFilter) return;
    this.setData({ activeFilter: key });
    this.refresh();
  },

  openOrder(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/order/order?id=' + id });
  },

  goShop() { wx.switchTab({ url: '/pages/shop/shop' }); },
});
