// Order success — terminal screen of the purchase funnel.
// Shows order number + total + next-step buttons.

const api  = require('../../utils/api');
const lang = require('../../utils/lang');
const cart = require('../../utils/cart');

Page({
  data: {
    orderId: null,
    orderNo: '',
    total: '',
    status: 'paid',
    isPickup: false,
    pickupLine: '',   // "Collect at <store> · <time>" — pickup orders only
    waitingLine: '',  // "Out of stock for now: …" — only an order parked on a restock
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

  // Defensive cart-badge clear — re-fires on show in case the
  // wx.removeTabBarBadge call from checkout (a non-tab page) got
  // dropped by some base-library versions.
  onShow() { cart.updateBadge(); },

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
      const isPickup = data.fulfillment_type === 'pickup';
      const patch = {
        orderNo: data.order_no || '',
        total: '¥' + Number(data.total || 0).toFixed(2),
        status: data.status,
        isPickup,
      };
      if (isPickup) {
        const cn = app.globalData.lang === 'cn';
        const store = cn
          ? (data.pickup_store_name_cn || data.pickup_store_name_en || '')
          : (data.pickup_store_name_en || data.pickup_store_name_cn || '');
        // Same three-step fallback as the order page and the tracker twins.
        const time = data.delivery_slot_display || data.delivery_slot_label
          || (data.scheduled_for ? String(data.scheduled_for).slice(0, 16) : '');
        const at = cn ? '取货时间' : 'at';
        patch.pickupLine = cn
          ? `🏬 到 ${store} 自提` + (time ? ` · ${at} ${time}` : '')
          : `🏬 Collect at ${store}` + (time ? ` · ${at} ${time}` : '');
        patch.copy = Object.assign({}, this.data.copy, {
          sub: cn ? '感谢，备好后我们会通知您。' : "Thanks! We'll let you know when it's ready.",
        });
      }
      // A paid order parked on a restock. Say so here, at the moment of paying:
      // "Order placed. We're on it." is false for an order nothing is happening to.
      const waiting = Array.isArray(data.waiting_items) ? data.waiting_items : [];
      if (data.status === 'awaiting_restock') {
        const cn = app.globalData.lang === 'cn';
        patch.copy = Object.assign({}, patch.copy || this.data.copy, {
          headline: cn ? '已付款，等待补货。' : 'Paid. Waiting for stock.',
          sub: cn ? '到货后整单一并发出。' : "We'll ship your whole order together once it's back.",
        });
        const names = waiting.map(w => lang.pick(w.name_en, w.name_cn, app.globalData.lang));
        if (names.length) {
          patch.waitingLine = cn
            ? '暂时缺货：' + names.join('、')
            : 'Out of stock for now: ' + names.join(', ');
        }
      }
      this.setData(patch);
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
