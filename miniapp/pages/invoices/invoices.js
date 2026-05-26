// My Invoices — the customer's fapiao (发票) list. Each row is an order where
// an invoice was requested; shows its state (issued vs processing) and, once
// issued, a button to open the fapiao PDF/link. Reads GET /api/retail/invoices.
const api = require('../../utils/api');

function fmtDate(s) { return s ? String(s).slice(0, 10) : ''; }

Page({
  data: {
    lang: 'en',
    loading: true,
    invoices: [],
    copy: {
      kicker: 'INVOICES · 发票',
      title: 'Your invoices.',
      stateIssued: 'Issued',
      stateRequested: 'Processing',
      view: 'View invoice',
      noFile: 'Issued — contact us for the file',
      emptyTitle: 'No invoices yet.',
      emptySub: 'Request an invoice at checkout — it appears here once issued.',
      typeCompany: 'Company',
      typePersonal: 'Personal',
      orderWord: 'Order',
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
      kicker: '发票 · INVOICES',
      title: '我的发票。',
      stateIssued: '已开具',
      stateRequested: '处理中',
      view: '查看发票',
      noFile: '已开具 — 请联系客服获取',
      emptyTitle: '暂无发票',
      emptySub: '结算时申请发票,开具后会显示在这里。',
      typeCompany: '企业',
      typePersonal: '个人',
      orderWord: '订单',
    } });
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) { try { await app.silentLogin(); } catch {} }
    if (!app.globalData.token) { this.setData({ loading: false }); return; }
    try {
      const res = await api.get('/api/retail/invoices');
      const list = Array.isArray(res) ? res : (res && res.data) || [];
      const c = this.data.copy;
      const invoices = list.map(o => ({
        id: o.id,
        orderNo: o.order_no,
        date: fmtDate(o.placed_at),
        total: Number(o.total || 0).toFixed(2),
        issued: o.invoice_state === 'issued',
        stateLabel: o.invoice_state === 'issued' ? c.stateIssued : c.stateRequested,
        typeLabel: o.invoice_type === 'company' ? c.typeCompany : c.typePersonal,
        title: o.invoice_title || '',
        number: o.invoice_number || '',
        fileUrl: o.invoice_file_url || '',
      }));
      this.setData({ invoices, loading: false });
    } catch (e) {
      console.warn('[invoices] refresh failed:', e.message);
      this.setData({ loading: false });
    }
  },

  onViewInvoice(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    const full = /^https?:\/\//.test(url) ? url : (api.BASE + url);
    wx.showLoading({ title: '' });
    wx.downloadFile({
      url: full,
      success: (res) => {
        wx.hideLoading();
        if (res.statusCode === 200) {
          wx.openDocument({ filePath: res.tempFilePath, fileType: 'pdf', fail: () => this.copyLink(full) });
        } else { this.copyLink(full); }
      },
      fail: () => { wx.hideLoading(); this.copyLink(full); },
    });
  },

  copyLink(url) {
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: this.data.lang === 'cn' ? '链接已复制' : 'Link copied', icon: 'none' }),
    });
  },
});
