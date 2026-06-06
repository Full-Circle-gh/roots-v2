// Notification center — the customer's in-app inbox (order, refund and invoice
// events for v1). Reads GET /api/retail/notifications; marks an item read on
// tap and deep-links to the related order / invoice.
const api = require('../../utils/api');

// Server stores timestamps as UTC ('YYYY-MM-DD HH:MM:SS' from CURRENT_TIMESTAMP)
// or ISO. Render a short relative label.
function relTime(iso, cn) {
  if (!iso) return '';
  const norm = String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z';
  const t = new Date(norm).getTime();
  if (isNaN(t)) return String(iso).slice(0, 16);
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return cn ? '刚刚' : 'just now';
  const m = Math.floor(s / 60); if (m < 60) return cn ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return cn ? `${h} 小时前` : `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return cn ? `${d} 天前` : `${d}d ago`;
  return String(iso).slice(0, 10);
}

const CAT = {
  order:     { en: 'ORDER',        cn: '订单' },
  refund:    { en: 'REFUND',       cn: '退款' },
  invoice:   { en: 'INVOICE',      cn: '发票' },
  broadcast: { en: '📣 ANNOUNCEMENT', cn: '📣 公告' },
};

Page({
  data: {
    lang: 'en',
    loading: true,
    items: [],
    anyUnread: false,
    copy: {
      kicker: 'NOTIFICATIONS',
      title: 'Your updates.',
      markAll: 'Mark all read',
      emptyTitle: 'No notifications yet.',
      emptySub: 'Order, refund and invoice updates will show up here.',
    },
  },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.applyLangCopy();
    this.refresh();
  },

  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },

  applyLangCopy() {
    if (this.data.lang !== 'cn') return;
    this.setData({ copy: {
      kicker: '通知',
      title: '我的消息。',
      markAll: '全部已读',
      emptyTitle: '暂无通知',
      emptySub: '订单、退款与发票的更新会显示在这里。',
    } });
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) { try { await app.silentLogin(); } catch {} }
    if (!app.globalData.token) { this.setData({ loading: false }); return; }
    const cn = this.data.lang === 'cn';
    try {
      const res = await api.get('/api/retail/notifications');
      const list = Array.isArray(res) ? res : (res && res.data) || [];
      const items = list.map(n => ({
        id: n.id,
        cat: n.category,
        catLabel: (CAT[n.category] || { en: n.category, cn: n.category })[cn ? 'cn' : 'en'],
        title: cn ? (n.title_cn || n.title_en) : (n.title_en || n.title_cn),
        body:  cn ? (n.body_cn || n.body_en || '') : (n.body_en || n.body_cn || ''),
        time:  relTime(n.created_at, cn),
        unread: !n.read_at,
        refType: n.ref_type || '',
        refId: n.ref_id || '',
      }));
      this.setData({ items, anyUnread: items.some(i => i.unread), loading: false });
    } catch (e) {
      console.warn('[notifications] refresh failed:', e.message);
      this.setData({ loading: false });
    }
  },

  onTapItem(e) {
    const { id, reftype, refid } = e.currentTarget.dataset;
    // Optimistically mark read; server confirms.
    const items = this.data.items.map(i => (i.id === id ? Object.assign({}, i, { unread: false }) : i));
    this.setData({ items, anyUnread: items.some(i => i.unread) });
    api.post('/api/retail/notifications/' + id + '/read').catch(() => {});
    if (reftype === 'order' && refid) {
      wx.navigateTo({ url: '/pages/order/order?id=' + refid });
    } else if (reftype === 'invoice') {
      wx.navigateTo({ url: '/pages/invoices/invoices' });
    } else if (reftype === 'deeplink' && refid) {
      // Broadcast deep-link: an internal mini-app path the operator chose.
      // Backend already validates it starts with /pages/. Tab-bar pages must
      // use switchTab; everything else is navigateTo.
      const path = String(refid);
      const TAB_PAGES = ['/pages/home/home', '/pages/shop/shop', '/pages/cart/cart', '/pages/me/me'];
      const root = path.split('?')[0];
      if (TAB_PAGES.includes(root)) {
        wx.switchTab({ url: root });
      } else {
        wx.navigateTo({ url: path });
      }
    }
  },

  async onMarkAll() {
    try { await api.post('/api/retail/notifications/read-all'); } catch {}
    const items = this.data.items.map(i => Object.assign({}, i, { unread: false }));
    this.setData({ items, anyUnread: false });
  },
});
