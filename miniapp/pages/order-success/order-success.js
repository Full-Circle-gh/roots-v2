// Order success — terminal screen of the purchase funnel.
// Shows order number + total + next-step buttons.

const api  = require('../../utils/api');
const lang = require('../../utils/lang');

Page({
  data: {
    orderId: null,
    orderNo: '',
    total: '',
    status: 'paid',
    lang: 'en',
    copy: {
      headline: 'Order placed.',
      sub: "Thank you. We're on it.",
      orderLabel: 'ORDER',
      totalLabel: 'TOTAL',
      viewBtn: 'View order →',
      shopBtn: 'Keep shopping',
    },
  },

  async onLoad(query) {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    if (app.globalData.lang === 'cn') {
      this.setData({
        copy: {
          headline: '订单已提交。',
          sub: '感谢，我们马上处理。',
          orderLabel: '订单号',
          totalLabel: '总额',
          viewBtn: '查看订单 →',
          shopBtn: '继续购物',
        },
      });
    }
    const id = parseInt(query.id, 10);
    if (!id) return;
    this.setData({ orderId: id });
    try {
      const o = await api.get('/api/retail/payment/status/' + id);
      const data = o?.data || o;
      this.setData({
        orderNo: data.order_no || '',
        total: '¥' + Number(data.total || 0).toFixed(2),
        status: data.status,
      });
    } catch (e) {
      console.warn('[order-success] load failed:', e.message);
    }
  },

  goShop() { wx.switchTab({ url: '/pages/shop/shop' }); },
  goHome() { wx.switchTab({ url: '/pages/home/home' }); },
  viewOrder() {
    if (!this.data.orderId) return wx.switchTab({ url: '/pages/me/me' });
    wx.redirectTo({ url: '/pages/order/order?id=' + this.data.orderId });
  },
});
