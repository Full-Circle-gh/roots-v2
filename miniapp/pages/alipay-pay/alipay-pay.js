// Alipay QR payment — terminal step when the customer chose Alipay.
// WeChat blocks jumping to / scanning Alipay in-app, so the flow is:
//   1. show the precreate QR (rendered server-side as a PNG image)
//   2. customer saves it and scans it from their Alipay app
//   3. we poll /payment/status until the async notify (or the server-side
//      trade.query fallback) flips the order to paid, then route to success.
const api    = require('../../utils/api');
const cart   = require('../../utils/cart');
const notify = require('../../utils/notifications');

const POLL_MS = 2500;

Page({
  data: {
    orderId: null,
    orderNo: '',
    total: '',
    qrPng: '',
    loading: true,
    paid: false,
    error: '',
    lang: 'en',
    t: {},
  },

  copyFor(l) {
    return l === 'cn' ? {
      title: '支付宝支付',
      amount: '应付金额',
      order: '订单号',
      steps: [
        '保存下方二维码到相册',
        '打开支付宝 →「扫一扫」→ 相册',
        '付款后本页会自动确认',
      ],
      save: '保存二维码到相册',
      waiting: '等待付款确认…',
      paidToast: '支付成功 ✓',
      saved: '已保存到相册',
      saveFail: '保存失败,请长按截屏',
      retry: '重新生成二维码',
      loadFail: '无法生成支付二维码',
    } : {
      title: 'Pay with Alipay',
      amount: 'Amount due',
      order: 'Order',
      steps: [
        'Save the QR code below to your album',
        'Open Alipay → "Scan" → pick from album',
        'This page confirms automatically once paid',
      ],
      save: 'Save QR to album',
      waiting: 'Waiting for payment…',
      paidToast: 'Paid ✓',
      saved: 'Saved to album',
      saveFail: 'Save failed — long-press to save',
      retry: 'Regenerate QR code',
      loadFail: 'Could not generate the payment QR',
    };
  },

  async onLoad(query) {
    const app = getApp();
    const l = (app && app.globalData && app.globalData.lang) || 'en';
    this.setData({ lang: l, t: this.copyFor(l) });
    const id = parseInt(query.id, 10);
    if (!id) { this.setData({ loading: false, error: this.copyFor(l).loadFail }); return; }
    this.setData({ orderId: id });
    await this.loadQr();
    this.startPolling();
  },

  onUnload() { this.stopPolling(); },
  onHide()   { this.stopPolling(); },
  onShow()   { if (this.data.orderId && !this.data.paid && this.data.qrPng) this.startPolling(); },

  async loadQr() {
    this.setData({ loading: true, error: '' });
    try {
      // Prefer the payload checkout/order already fetched (avoids a 2nd
      // precreate round-trip); fall back to creating it here.
      let pay = null;
      try { pay = wx.getStorageSync('alipayPay:' + this.data.orderId) || null; } catch (e) {}
      if (pay) { try { wx.removeStorageSync('alipayPay:' + this.data.orderId); } catch (e) {} }
      if (!pay || !pay.qr_png) {
        pay = await api.post('/api/retail/payment/create', { order_id: this.data.orderId });
      }
      // Points / dev / zero-total path: already settled, skip the QR.
      if (pay && (pay.status === 'paid' || pay.dev)) return this.onPaid();
      if (!pay || !pay.qr_png) throw new Error('no_qr');
      this.setData({
        qrPng: pay.qr_png,
        orderNo: pay.order_no || '',
        total: '¥' + Number(pay.total || 0).toFixed(2),
        loading: false,
      });
    } catch (e) {
      console.warn('[alipay-pay] loadQr failed:', e.message);
      this.setData({ loading: false, error: this.data.t.loadFail });
    }
  },

  startPolling() {
    if (this._timer || this.data.paid) return;
    this._timer = setInterval(() => this.poll(), POLL_MS);
  },
  stopPolling() { if (this._timer) { clearInterval(this._timer); this._timer = null; } },

  async poll() {
    if (!this.data.orderId || this.data.paid) return;
    try {
      const o = await api.get('/api/retail/payment/status/' + this.data.orderId);
      if (o && (o.status === 'paid' || o.status === 'awaiting_restock')) this.onPaid();
    } catch (e) { /* transient network/auth blip — keep polling */ }
  },

  onPaid() {
    if (this.data.paid) return;
    this.setData({ paid: true });
    this.stopPolling();
    cart.clear();
    wx.showToast({ title: this.data.t.paidToast, icon: 'success' });
    notify.requestOrderStatusSubscription(this.data.orderId)
      .catch(() => {})
      .then(() => wx.redirectTo({ url: '/pages/order-success/order-success?id=' + this.data.orderId }));
  },

  saveQr() {
    const dataUrl = this.data.qrPng;
    if (!dataUrl) return;
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const fp = `${wx.env.USER_DATA_PATH}/alipay-qr-${this.data.orderId}.png`;
    const fs = wx.getFileSystemManager();
    const doSave = () => {
      fs.writeFile({
        filePath: fp, data: base64, encoding: 'base64',
        success: () => wx.saveImageToPhotosAlbum({
          filePath: fp,
          success: () => wx.showToast({ title: this.data.t.saved, icon: 'success' }),
          fail:    () => wx.showToast({ title: this.data.t.saveFail, icon: 'none' }),
        }),
        fail: () => wx.showToast({ title: this.data.t.saveFail, icon: 'none' }),
      });
    };
    wx.getSetting({
      success: (s) => {
        if (s.authSetting && s.authSetting['scope.writePhotosAlbum'] === false) {
          wx.openSetting({ success: () => doSave() });
        } else { doSave(); }
      },
      fail: doSave,
    });
  },

  retry() { this.loadQr(); },
});
