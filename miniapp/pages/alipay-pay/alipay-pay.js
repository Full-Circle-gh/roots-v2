// Alipay payment — terminal step when the customer chose Alipay.
// Two modes (server decides in /payment/create):
//   • auto   — 当面付 precreate QR; we poll /payment/status and the async notify
//              (or trade.query fallback) flips the order to paid automatically.
//   • manual — a static 收款码 (while 当面付 API access is blocked): customer
//              scans it, pays the shown amount, and uploads the payment
//              screenshot; staff eyeball it and Mark paid (poll catches that).
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
    manual: false,        // static-收款码 fallback mode
    account: '',          // payee label (manual mode)
    proofUploaded: false, // customer has uploaded a payment screenshot
    uploading: false,
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
      payee: '收款方',
      steps: [
        '保存下方二维码到相册',
        '打开支付宝 →「扫一扫」→ 相册',
        '付款后本页会自动确认',
      ],
      manualSteps: [
        '用支付宝「扫一扫」扫描下方二维码',
        '务必按显示的金额付款',
        '付款后上传付款截图,客服核对后确认订单',
      ],
      save: '保存二维码到相册',
      waiting: '等待付款确认…',
      manualWaiting: '已收到截图,客服核对中…',
      upload: '上传付款截图',
      reupload: '重新上传截图',
      uploaded: '已上传 ✓',
      uploadFail: '上传失败,请重试',
      paidToast: '支付成功 ✓',
      saved: '已保存到相册',
      saveFail: '保存失败,请长按截屏',
      retry: '重新加载',
      loadFail: '无法加载支付二维码',
    } : {
      title: 'Pay with Alipay',
      amount: 'Amount due',
      order: 'Order',
      payee: 'Pays to',
      steps: [
        'Save the QR code below to your album',
        'Open Alipay → "Scan" → pick from album',
        'This page confirms automatically once paid',
      ],
      manualSteps: [
        'Scan the QR below with Alipay "Scan"',
        'Pay the EXACT amount shown above',
        'Upload your payment screenshot — we confirm shortly',
      ],
      save: 'Save QR to album',
      waiting: 'Waiting for payment…',
      manualWaiting: 'Screenshot received — confirming…',
      upload: 'Upload payment screenshot',
      reupload: 'Re-upload screenshot',
      uploaded: 'Uploaded ✓',
      uploadFail: 'Upload failed, try again',
      paidToast: 'Paid ✓',
      saved: 'Saved to album',
      saveFail: 'Save failed — long-press to save',
      retry: 'Reload',
      loadFail: 'Could not load the payment QR',
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
      // create round-trip); fall back to creating it here.
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
        manual: pay.mode === 'manual',
        account: pay.account || '',
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

  // Manual mode: customer picks the Alipay payment screenshot and we stash it on
  // the order for staff to verify. Order stays pending until staff Mark paid.
  uploadProof() {
    if (this.data.uploading) return;
    wx.chooseImage({
      count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: (r) => {
        const path = r.tempFilePaths && r.tempFilePaths[0];
        if (!path) return;
        this.setData({ uploading: true });
        const ext = (path.split('.').pop() || 'png').toLowerCase();
        const mime = (ext === 'jpg' || ext === 'jpeg') ? 'jpeg' : (ext === 'webp' ? 'webp' : 'png');
        wx.getFileSystemManager().readFile({
          filePath: path, encoding: 'base64',
          success: (fr) => {
            api.post('/api/retail/payment/alipay-proof/' + this.data.orderId, { image: 'data:image/' + mime + ';base64,' + fr.data })
              .then(() => {
                this.setData({ uploading: false, proofUploaded: true });
                wx.showToast({ title: this.data.t.uploaded, icon: 'success' });
              })
              .catch(() => {
                this.setData({ uploading: false });
                wx.showToast({ title: this.data.t.uploadFail, icon: 'none' });
              });
          },
          fail: () => { this.setData({ uploading: false }); wx.showToast({ title: this.data.t.uploadFail, icon: 'none' }); },
        });
      },
    });
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
