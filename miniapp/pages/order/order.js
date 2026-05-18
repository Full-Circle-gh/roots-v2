// Order detail — full single-order view with vertical timeline.
// Reads /api/retail/orders/:id which returns items + timeline events.

const api  = require('../../utils/api');
const lang = require('../../utils/lang');

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
    id: null,
    order: null,
    items: [],
    timeline: [],
    tracking: null,
    trackingEvents: [],
    trackingEventsVisible: [],   // computed: 1 latest by default, all when expanded
    trackingEventsExpanded: false,
    subtotal: '',
    shipping: '',
    total: '',
    statusLabel: '',
    address: '',
    paymentLabel: '',
    lang: 'en',
    loading: true,
    notFound: false,
    copy: {
      title: 'Order',
      statusLabel: 'STATUS',
      shipToLabel: 'SHIP TO',
      payLabel: 'PAYMENT',
      itemsLabel: 'ITEMS',
      timelineLabel: 'TIMELINE',
      trackingLabel: 'SHIPMENT TRACKING',
      trackingNoEvents: 'Waiting for the first update from the carrier.',
      trackingPending: 'Tracking will appear here shortly.',
      trackingViewLive: 'View full tracking',
      subtotalLabel: 'Subtotal',
      shippingLabel: 'Shipping',
      totalLabel: 'Total',
      noteLabel: 'Note',
      back: '← Back',
      payNowBtn: 'PAY NOW →',
      cancelBtn: 'Cancel order',
      cancelConfirm: 'Cancel this order?',
      cancelConfirmSub: 'You can place a new one anytime.',
      paying: 'Processing…',
      reorderBtn: 'Reorder',
      refundBtn: 'Request refund',
      refundTitle: 'Request a refund',
      refundReasonPlaceholder: 'Tell us what happened (optional)',
      refundSubmit: 'Submit request',
      refundPendingBanner: '🕒 Refund requested — we\'ll review within 24h.',
      refundRejectedBanner: '✗ Refund request rejected',
      refundApprovedBanner: '✓ Refund approved',
    },
  },

  async onLoad(query) {
    const app = getApp();
    this.setData({ lang: app.globalData.lang, id: parseInt(query.id, 10) || null });
    this.applyLangCopy();
    await this.refresh();
  },

  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  applyLangCopy() {
    if (this.data.lang !== 'cn') return;
    this.setData({
      copy: {
        title: '订单',
        statusLabel: '状态',
        shipToLabel: '收货地址',
        payLabel: '支付',
        itemsLabel: '商品',
        timelineLabel: '订单进度',
        trackingLabel: '物流跟踪',
        trackingNoEvents: '等待承运商首次更新…',
        trackingPending: '物流信息即将更新。',
        trackingViewLive: '查看完整物流',
        subtotalLabel: '小计',
        shippingLabel: '运费',
        totalLabel: '总计',
        noteLabel: '备注',
        back: '← 返回',
        payNowBtn: '立即支付 →',
        cancelBtn: '取消订单',
        cancelConfirm: '取消此订单?',
        cancelConfirmSub: '您可以随时重新下单。',
        paying: '处理中…',
        reorderBtn: '再次购买',
        refundBtn: '申请退款',
        refundTitle: '申请退款',
        refundReasonPlaceholder: '说明一下情况 (可选)',
        refundSubmit: '提交申请',
        refundPendingBanner: '🕒 退款已申请 — 我们将在 24 小时内审核。',
        refundRejectedBanner: '✗ 退款申请未通过',
        refundApprovedBanner: '✓ 退款已通过',
      },
    });
  },

  async refresh() {
    if (!this.data.id) return;
    this.setData({ loading: true });
    try {
      const o = await api.get('/api/retail/orders/' + this.data.id);
      const data = o?.data || o;
      const L = this.data.lang;
      const labels = L === 'cn' ? STATUS_LABELS_CN : STATUS_LABELS_EN;
      const items = (data.items || []).map(it => {
        const opts = it.options || [];
        return {
          ...it,
          display_name: lang.pick(it.name_en, it.name_cn, L),
          line_total_display: '¥' + Number(it.line_total || 0).toFixed(2),
          image: absUrl(it.image_url) || '',
          options_str: opts.length ? opts.map(o => o.label).join(', ') : '',
        };
      });
      // Timeline — render each step with done / active / future state
      const timeline = (data.timeline || []).map((step, i) => ({
        ...step,
        label_display: L === 'cn' ? step.cn : step.label,
        // Pending shares its timestamp with Preparing (same transition);
        // hide it to avoid duplicate times rendering one after the other.
        at_short: (step.at && step.key !== 'pending') ? step.at.slice(0, 16) : '',
        done:   !!step.at,
      }));
      // Mark the most-recent COMPLETED step as "active" — that's where the
      // order currently sits. Highlighting the next pending step instead
      // misreads as "we're already at delivered" when the order is still
      // out for delivery. The active treatment goes to the last done step.
      let lastDoneIndex = -1;
      timeline.forEach((s, i) => { if (s.done) lastDoneIndex = i; });
      if (lastDoneIndex >= 0) timeline[lastDoneIndex].active = true;

      // Tracking events: server returns description_cn + description_en
      // (the latter translated by a pattern-matching helper that covers
      // the ~20 canonical Chinese phrases carriers actually emit). We
      // pick the one matching the current language so the customer sees
      // their preferred locale; fallback to Chinese if no EN exists.
      const tracking = data.tracking || null;
      const trackingEvents = (tracking?.events || []).map(ev => ({
        ...ev,
        time: (ev.time || '').slice(0, 16),
        description: L === 'cn'
          ? (ev.description_cn || ev.description_en || '')
          : (ev.description_en || ev.description_cn || ''),
      }));

      // Collapse to just the latest event by default — the section was
      // dominating the order page on long-haul shipments with 10+ events.
      // Preserves the user's expand state across refreshes (e.g. pull
      // to refresh keeps the section open if they had it open).
      const expanded = this.data.trackingEventsExpanded;
      const trackingEventsVisible = expanded ? trackingEvents : trackingEvents.slice(0, 1);

      this.setData({
        order: data,
        items,
        timeline,
        tracking,
        trackingEvents,
        trackingEventsVisible,
        subtotal: '¥' + Number(data.subtotal || 0).toFixed(2),
        shipping: Number(data.shipping_fee || 0) > 0
          ? '¥' + Number(data.shipping_fee || 0).toFixed(2)
          : (L === 'cn' ? '免费' : 'FREE'),
        total: '¥' + Number(data.total || 0).toFixed(2),
        statusLabel: labels[data.status] || data.status,
        address: data.address_full || '',
        paymentLabel: (data.payment_method || '').toUpperCase(),
        loading: false,
      });
    } catch (e) {
      console.warn('[order] load failed:', e.message);
      this.setData({ notFound: true, loading: false });
    }
  },

  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/me/me' }) }); },

  // Expand or collapse the tracking events list. Collapsed = only the
  // latest event renders; expanded = full history visible inline.
  toggleTrackingEvents() {
    const expanded = !this.data.trackingEventsExpanded;
    const trackingEventsVisible = expanded
      ? this.data.trackingEvents
      : this.data.trackingEvents.slice(0, 1);
    this.setData({ trackingEventsExpanded: expanded, trackingEventsVisible });
  },

  // Tap the tracking-number row → copy the waybill number to clipboard.
  // Same affordance the scenario banner offers for pickup codes; the
  // 📋 icon next to the number signals the row is tappable.
  copyTracking() {
    const n = (this.data.tracking && this.data.tracking.number) || '';
    if (!n) return;
    wx.setClipboardData({
      data: n,
      success: () => wx.showToast({
        title: this.data.lang === 'cn' ? '运单号已复制' : 'Tracking number copied',
        icon: 'success',
      }),
    });
  },

  // Tap on the scenario banner — copies the pickup code to clipboard if
  // one is present (the customer needs this to retrieve the package at
  // a 菜鸟驿站 or 快递柜). For other scenarios (in_person, no_contact,
  // etc.) the banner is informational only; tap is a no-op.
  onScenarioTap() {
    const sc = (this.data.tracking && this.data.tracking.scenario) || null;
    if (!sc || !sc.pickup_code) return;
    wx.setClipboardData({
      data: sc.pickup_code,
      success: () => wx.showToast({
        title: this.data.lang === 'cn' ? '取件码已复制' : 'Pickup code copied',
        icon: 'success',
      }),
    });
  },

  // Open the full editorial tracking page inside WeChat via the
  // pages/track-webview page (which wraps a <web-view> pointing at
  // https://rootskitchenchina.com/track/:orderNo/:number). The host
  // domain is now in the AppID's 业务域名 whitelist (added 2026-05-18)
  // so the web-view loads without the "无法打开该页面" error.
  // Fallback: if wx.navigateTo fails for any reason (older mini-app
  // version, missing page, etc.) we copy the tracking number so the
  // customer can paste it into the JD app instead.
  openCarrierLink() {
    const o = this.data.order || {};
    const t = this.data.tracking || {};
    if (!o.order_no || !t.number) return;
    wx.navigateTo({
      url: `/pages/track-webview/track-webview?order_no=${encodeURIComponent(o.order_no)}&number=${encodeURIComponent(t.number)}`,
      fail: () => {
        wx.setClipboardData({
          data: t.number,
          success: () => wx.showToast({
            title: this.data.lang === 'cn' ? '运单号已复制' : 'Tracking copied',
            icon: 'success',
          }),
        });
      },
    });
  },

  async payNow() {
    if (this.data.paying) return;
    this.setData({ paying: true });
    try {
      const pay = await api.post('/api/retail/payment/create', { order_id: this.data.id });
      const payData = pay?.data || pay;
      if (payData?.dev || payData?.status === 'paid') {
        wx.showToast({ title: this.data.lang === 'cn' ? '已支付 ✓' : 'Paid ✓', icon: 'success' });
        await this.refresh();
      } else if (this.data.order.payment_method === 'wechat' && payData?.timeStamp) {
        wx.requestPayment({
          timeStamp: payData.timeStamp, nonceStr: payData.nonceStr,
          package: payData.package, signType: payData.signType, paySign: payData.paySign,
          success: () => { this.refresh(); },
          fail:    () => wx.showToast({ title: this.data.lang === 'cn' ? '支付未完成' : 'Payment incomplete', icon: 'none' }),
        });
      } else {
        wx.showToast({ title: 'Payment flow TBD', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ paying: false });
    }
  },

  writeReview(e) {
    const ds = e.currentTarget.dataset;
    const productId = ds.productId;
    if (!productId) return;
    const o = this.data.order || {};
    // Prefer the actual delivered timestamp from the timeline; fall
    // back to the order's updated_at if the step lacks `at`.
    const deliveredStep = (o.timeline || []).find(s => s.key === 'delivered');
    const deliveredAt = (deliveredStep && deliveredStep.at) || o.delivered_at || o.updated_at || '';
    const qp = [
      'product_id=' + productId,
      'order_id=' + this.data.id,
      'product_name=' + encodeURIComponent(ds.name || ''),
      'product_image=' + encodeURIComponent(ds.image || ''),
      'qty=' + (parseInt(ds.qty, 10) || 1),
      'order_no=' + encodeURIComponent(o.order_no || ''),
      'delivered_at=' + encodeURIComponent(deliveredAt),
    ].join('&');
    wx.navigateTo({ url: '/pages/review/review?' + qp });
  },

  reorder() {
    const cart = require('../../utils/cart');
    const items = this.data.items || [];
    if (!items.length) return;
    items.forEach(it => {
      cart.add({
        id: it.product_id,
        name_en: it.name_en, name_cn: it.name_cn,
        sku: it.sku, size: it.size,
        image_url: it.image_url || it.image,
        price: it.unit_price,
      }, it.qty, it.options || []);
    });
    wx.showToast({
      title: this.data.lang === 'cn' ? '已加入购物车' : 'Added to cart',
      icon: 'success',
    });
    setTimeout(() => wx.switchTab({ url: '/pages/cart/cart' }), 600);
  },

  async requestRefund() {
    const reason = await new Promise(resolve =>
      wx.showModal({
        title: this.data.copy.refundTitle,
        editable: true,
        placeholderText: this.data.copy.refundReasonPlaceholder,
        confirmText: this.data.copy.refundSubmit,
        cancelText: this.data.lang === 'cn' ? '返回' : 'Cancel',
        success: r => resolve(r.confirm ? (r.content || '') : null),
      })
    );
    if (reason === null) return;
    try {
      await api.post('/api/retail/orders/' + this.data.id + '/refund-request', { reason });
      wx.showToast({
        title: this.data.lang === 'cn' ? '已提交' : 'Submitted',
        icon: 'success',
      });
      await this.refresh();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async cancelOrder() {
    const ok = await new Promise(resolve =>
      wx.showModal({
        title: this.data.copy.cancelConfirm,
        content: this.data.copy.cancelConfirmSub,
        confirmText: this.data.lang === 'cn' ? '取消订单' : 'Cancel order',
        cancelText:  this.data.lang === 'cn' ? '返回' : 'Back',
        confirmColor: '#E96174',
        success: r => resolve(r.confirm),
      })
    );
    if (!ok) return;
    try {
      await api.post('/api/retail/orders/' + this.data.id + '/cancel', { reason: 'customer_cancelled' });
      wx.showToast({ title: this.data.lang === 'cn' ? '订单已取消' : 'Cancelled', icon: 'success' });
      await this.refresh();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
