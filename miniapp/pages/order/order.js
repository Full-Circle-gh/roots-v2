// Order detail — full single-order view with vertical timeline.
// Reads /api/retail/orders/:id which returns items + timeline events.

const api  = require('../../utils/api');
const lang = require('../../utils/lang');
const { createPoller } = require('../../utils/livepoll');

// Statuses past which the order no longer changes on its own — stop polling.
const TERMINAL_STATUS = new Set(['delivered', 'cancelled', 'refunded']);

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
    shipments: [],
    partialShip: null,           // {line, sub} when some-but-not-all parcels shipped
    trackingEvents: [],
    trackingEventsVisible: [],   // computed: 1 latest by default, all when expanded
    trackingEventsExpanded: false,
    subtotal: '',
    shipping: '',
    total: '',
    statusLabel: '',
    address: '',
    paymentLabel: '',
    isPickup: false,
    pickupStoreName: '',
    pickupAddress: '',
    pickupPhone: '',
    pickupTime: '',
    lang: 'en',
    loading: true,
    notFound: false,
    copy: {
      title: 'Order',
      statusLabel: 'STATUS',
      shipToLabel: 'SHIP TO',
      collectAtLabel: 'COLLECT AT',
      pickupTimeLabel: 'PICKUP TIME',
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
      refundModeFull: 'Full refund',
      refundModeAmount: 'Partial — amount',
      refundModeLines: 'Partial — by item',
      refundAmountLabel: 'Refund amount (¥)',
      refundLinesLabel: 'Choose item(s)',
      refundLinesTotal: 'Items total',
      refundCancelBtn: 'Cancel',
      refundWithdraw: 'Withdraw request',
      refundWithdrawConfirm: 'Withdraw this refund request?',
      refundOf: 'of',
      refundStateRequested:  '🕒 Refund requested — we\'ll review within 24h.',
      refundStateReviewing:  '🔍 We\'re looking into your request.',
      refundStateApproved:   '✓ Refund approved — awaiting payout.',
      refundStatePaid:       '✓ Refund paid back to you.',
      refundStateRejected:   '✗ Refund request rejected',
      refundStateWithdrawn:  '↺ You withdrew this refund request.',
      invoiceBtn: 'Request invoice',
      invoiceTitle: 'Request an invoice (fapiao)',
      invPersonal: 'Personal',
      invCompany: 'Company',
      invTitleLabel: 'Invoice title',
      invTitlePh: 'Your name or company',
      invTaxLabel: 'Company tax ID',
      invTaxPh: '统一社会信用代码 / 税号',
      invEmailLabel: 'Email for the e-invoice',
      invEmailPh: 'you@example.com',
      invoiceSubmit: 'Submit request',
      invoiceProcessing: '🧾 Invoice requested — we\'ll email it once issued.',
      invoiceIssued: '✓ Invoice issued',
    },
    // Refund sheet state
    refundSheetOpen: false,
    refundBusy: false,
    refundMode: 'full',       // 'full' | 'amount' | 'lines'
    refundAmount: '',
    refundOrderTotalDisp: '0.00',
    refundReason: '',
    refundLines: [],          // [{ item_id, name, qty, max_qty, unit, picked, refund_qty, amount }]
    refundLinesTotalDisp: '¥0.00',
    refundStateLabel: '',     // banner copy for current refund_status
    refundShowAmounts: false, // show amount summary block in banner
    // Invoice (发票) request sheet state
    invoiceSheetOpen: false,
    invoiceBusy: false,
    invoiceType: 'personal',  // 'personal' | 'company'
    invoiceTitle: '',
    invoiceTaxId: '',
    invoiceEmail: '',
  },

  async onLoad(query) {
    const app = getApp();
    this.setData({ lang: app.globalData.lang, id: parseInt(query.id, 10) || null });
    this.applyLangCopy();
    await this.refresh();
  },

  onShow() {
    // First show is covered by onLoad's refresh; on later re-entries (e.g.
    // back from the Alipay page, or returning after the admin advanced the
    // order) re-pull so the status/timeline reflect the latest state.
    if (this.data.order) this.refresh(true);
    // Keep the order live while it's on screen and still in flight.
    if (!this._orderPoller) {
      this._orderPoller = createPoller(() => {
        const st = this.data.order && this.data.order.status;
        if (st && TERMINAL_STATUS.has(st)) { this._orderPoller.stop(); return; }
        return this.refresh(true);
      });
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
    if (this.data.lang !== 'cn') return;
    this.setData({
      copy: {
        title: '订单',
        statusLabel: '状态',
        shipToLabel: '收货地址',
        collectAtLabel: '自提门店',
        pickupTimeLabel: '取货时间',
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
        refundModeFull: '全额退款',
        refundModeAmount: '部分退款 — 金额',
        refundModeLines: '部分退款 — 按商品',
        refundAmountLabel: '退款金额 (¥)',
        refundLinesLabel: '选择商品',
        refundLinesTotal: '商品合计',
        refundCancelBtn: '取消',
        refundWithdraw: '撤回申请',
        refundWithdrawConfirm: '确定撤回退款申请?',
        refundOf: '/',
        refundStateRequested:  '🕒 退款已申请 — 我们将在 24 小时内审核。',
        refundStateReviewing:  '🔍 我们正在处理您的申请。',
        refundStateApproved:   '✓ 退款已批准 — 等待退款到账。',
        refundStatePaid:       '✓ 退款已退回您的账户。',
        refundStateRejected:   '✗ 退款申请未通过',
        refundStateWithdrawn:  '↺ 您已撤回退款申请。',
        invoiceBtn: '申请发票',
        invoiceTitle: '申请发票',
        invPersonal: '个人',
        invCompany: '企业',
        invTitleLabel: '发票抬头',
        invTitlePh: '姓名或公司名称',
        invTaxLabel: '企业税号',
        invTaxPh: '统一社会信用代码 / 税号',
        invEmailLabel: '接收电子发票的邮箱',
        invEmailPh: 'you@example.com',
        invoiceSubmit: '提交申请',
        invoiceProcessing: '🧾 发票已申请 — 开具后将发送至您的邮箱。',
        invoiceIssued: '✓ 发票已开具',
      },
    });
  },

  async refresh(silent = false) {
    if (!this.data.id) return;
    // Silent refreshes (background poll / re-entry) skip the loading flag so
    // the page doesn't flash its skeleton while the user is reading it.
    if (!silent) this.setData({ loading: true });
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

      // Split-package orders return shipments[] (one per parcel, each with its
      // own waybill + items). When present we render a card per parcel instead
      // of the single tracking block, so the customer sees every tracking
      // number — not just the primary shipment's.
      const shipments = (data.shipments || []).map(s => {
        const latest = (s.events || [])[0] || null;
        return {
          shipment_id: s.shipment_id,
          label: L === 'cn'
            ? `包裹 ${s.index} / ${s.total}`
            : `Package ${s.index} of ${s.total}`,
          carrier_name: L === 'cn' ? s.carrier_name_cn : s.carrier_name_en,
          number: s.number,
          status_label: L === 'cn' ? s.status_label_cn : s.status_label_en,
          synced_at: s.synced_at,
          latest_event: latest ? {
            description: L === 'cn'
              ? (latest.description_cn || latest.description_en || '')
              : (latest.description_en || latest.description_cn || ''),
            time: (latest.time || '').slice(0, 16),
            location: latest.location || '',
          } : null,
          items_str: (s.items || [])
            .map(it => `${lang.pick(it.name_en, it.name_cn, L)} ×${it.qty}`)
            .join(L === 'cn' ? '、' : ', '),
        };
      });

      // Collapse to just the latest event by default — the section was
      // dominating the order page on long-haul shipments with 10+ events.
      // Preserves the user's expand state across refreshes (e.g. pull
      // to refresh keeps the section open if they had it open).
      const expanded = this.data.trackingEventsExpanded;
      const trackingEventsVisible = expanded ? trackingEvents : trackingEvents.slice(0, 1);

      // Refund view — render the current refund state into a single block
      // the WXML can read without piles of conditionals.
      const C = this.data.copy;
      const stateMap = {
        pending:   { label: C.refundStateRequested, theme: 'pending'  },
        reviewing: { label: C.refundStateReviewing, theme: 'pending'  },
        approved:  { label: C.refundStateApproved,  theme: 'approved' },
        paid:      { label: C.refundStatePaid,      theme: 'approved' },
        rejected:  { label: C.refundStateRejected,  theme: 'rejected' },
        withdrawn: { label: C.refundStateWithdrawn, theme: 'rejected' },
      };
      let refundView = null;
      if (data.refund_status || data.status === 'refunded') {
        const eff = data.refund_status || 'paid';
        const s = stateMap[eff] || { label: eff, theme: 'pending' };
        const total = Number(data.total) || 0;
        const reqAmt = data.refund_amount_requested != null ? Number(data.refund_amount_requested) : null;
        const apvAmt = data.refund_amount_approved  != null ? Number(data.refund_amount_approved)  : null;
        const paidAmt = data.refund_amount_paid     != null ? Number(data.refund_amount_paid)      : null;
        const isPartial = (reqAmt != null && reqAmt + 0.005 < total) || (apvAmt != null && apvAmt + 0.005 < total);
        refundView = {
          state: eff,
          label: s.label,
          theme: s.theme,
          reason: data.refund_reason || '',
          review_note: data.refund_review_note || '',
          can_withdraw: ['pending', 'reviewing'].includes(eff),
          show_amounts: !!(reqAmt || apvAmt || paidAmt),
          requested_disp: reqAmt  != null ? '¥' + reqAmt.toFixed(2)  : '',
          approved_disp:  apvAmt  != null ? '¥' + apvAmt.toFixed(2)  : '',
          paid_disp:      paidAmt != null ? '¥' + paidAmt.toFixed(2) : '',
          total_disp: '¥' + total.toFixed(2),
          is_partial: isPartial,
          payout_method: data.refund_payout_method || '',
        };
      }

      // Partial shipment — "X of Y items shipped, the rest to follow". The
      // server only returns fulfillment.partial for a split order that's
      // mid-flight (some parcels out, some not), so a single banner reads it.
      const f = data.fulfillment;
      let partialShip = null;
      if (f && f.partial) {
        const left = f.items_to_follow;
        partialShip = L === 'cn'
          ? { line: `已发货 ${f.items_shipped}/${f.items_total} 件商品`,
              sub:  `还有 ${left} 件稍后寄出` }
          : { line: `${f.items_shipped} of ${f.items_total} items shipped`,
              sub:  `${left} ${left === 1 ? 'item is' : 'items are'} still to follow` };
      }

      // Pickup orders collect at a store instead of shipping to an address.
      // Build a "Collect at <store>" location string from the store fields
      // carried in address_json (parsed server-side into data.address), and
      // surface the chosen pickup time. order.wxml uses isPickup to swap the
      // delivery address/tracking blocks for pickup equivalents.
      const isPickup = data.fulfillment_type === 'pickup';
      const pa = data.address || {};
      const pickupStoreName = isPickup
        ? (lang.pick(pa.store_name_en, pa.store_name_cn, L) || pa.store_name_en || pa.store_name_cn || '')
        : '';
      const pickupAddress = isPickup ? (pa.address || data.address_full || '') : '';
      const pickupPhone = isPickup ? (pa.store_phone || '') : '';
      const pickupTime = isPickup
        ? (data.delivery_slot_label || (data.scheduled_for ? String(data.scheduled_for).slice(0, 16) : ''))
        : '';

      this.setData({
        order: data,
        items,
        timeline,
        tracking,
        shipments,
        partialShip,
        trackingEvents,
        trackingEventsVisible,
        refundView,
        isPickup,
        pickupStoreName,
        pickupAddress,
        pickupPhone,
        pickupTime,
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
      // A background poll hitting a transient error must not blank a page the
      // user is already reading — only the initial/explicit load shows notFound.
      if (silent) return;
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

  // Copy a specific parcel's waybill number (split-package orders show one
  // tracking card per parcel; each card's number row is independently copyable).
  copyShipmentTracking(e) {
    const n = e.currentTarget.dataset.number || '';
    if (!n) return;
    wx.setClipboardData({
      data: n,
      success: () => wx.showToast({
        title: this.data.lang === 'cn' ? '运单号已复制' : 'Tracking number copied',
        icon: 'success',
      }),
    });
  },

  // Open the full carrier tracking page for one parcel of a split-package order.
  openShipmentLink(e) {
    const o = this.data.order || {};
    const n = e.currentTarget.dataset.number || '';
    if (!o.order_no || !n) return;
    wx.navigateTo({
      url: `/pages/track-webview/track-webview?order_no=${encodeURIComponent(o.order_no)}&number=${encodeURIComponent(n)}`,
      fail: () => {
        wx.setClipboardData({
          data: n,
          success: () => wx.showToast({
            title: this.data.lang === 'cn' ? '运单号已复制' : 'Tracking copied',
            icon: 'success',
          }),
        });
      },
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
      } else if (this.data.order.payment_method === 'alipay' && payData?.qr_png) {
        // Hand off to the Alipay QR page (renders + polls until paid). Stash
        // payData so it skips a second precreate. navigateTo (not redirect) so
        // the customer can back out to this order if they don't pay.
        try { wx.setStorageSync('alipayPay:' + this.data.id, payData); } catch {}
        wx.navigateTo({ url: '/pages/alipay-pay/alipay-pay?id=' + this.data.id });
      } else {
        console.error('[order] no payment handler for', this.data.order.payment_method, payData);
        wx.showToast({ title: this.data.lang === 'cn' ? '支付方式暂不可用' : 'Payment unavailable', icon: 'none' });
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

  // ─── Refund flow ──────────────────────────────────────────────────
  // Open the partial-refund sheet. Pre-fills full amount + line list from
  // current order items.
  openRefundSheet() {
    const o = this.data.order || {};
    const total = Number(o.total) || 0;
    const lines = (this.data.items || []).map(it => {
      const qty = Number(it.qty) || 0;
      const unit = qty > 0 ? (Number(it.line_total) / qty) : Number(it.unit_price || 0);
      return {
        item_id: it.id,
        name: it.display_name || it.name_en || it.name_cn || ('item #' + it.id),
        qty,
        max_qty: qty,
        unit,
        unit_disp: '¥' + unit.toFixed(2),
        picked: false,
        refund_qty: qty,
        amount: 0,
        amount_disp: '¥0.00',
      };
    });
    this.setData({
      refundSheetOpen: true,
      refundMode: 'full',
      refundAmount: total.toFixed(2),
      refundOrderTotalDisp: total.toFixed(2),
      refundReason: '',
      refundLines: lines,
      refundLinesTotalDisp: '¥0.00',
    });
  },
  closeRefundSheet() {
    if (this.data.refundBusy) return;
    this.setData({ refundSheetOpen: false });
  },
  onRefundSheetMaskTap() { this.closeRefundSheet(); },
  // Stop tap-through so taps inside the sheet body don't bubble up to the mask.
  noop() {},

  // ── Invoice (发票) request ───────────────────────────────────────────
  openInvoiceSheet() {
    const o = this.data.order || {};
    this.setData({
      invoiceSheetOpen: true,
      invoiceType:  o.invoice_type === 'company' ? 'company' : 'personal',
      invoiceTitle: o.invoice_title || '',
      invoiceTaxId: o.invoice_tax_id || '',
      invoiceEmail: o.invoice_email || '',
    });
  },
  closeInvoiceSheet() {
    if (this.data.invoiceBusy) return;
    this.setData({ invoiceSheetOpen: false });
  },
  onInvoiceSheetMaskTap() { this.closeInvoiceSheet(); },
  onInvTypeTap(e)    { this.setData({ invoiceType: e.currentTarget.dataset.type }); },
  onInvTitleInput(e) { this.setData({ invoiceTitle: e.detail.value }); },
  onInvTaxInput(e)   { this.setData({ invoiceTaxId: e.detail.value }); },
  onInvEmailInput(e) { this.setData({ invoiceEmail: e.detail.value }); },
  async submitInvoice() {
    const cn = this.data.lang === 'cn';
    const title = (this.data.invoiceTitle || '').trim();
    const taxId = (this.data.invoiceTaxId || '').trim();
    const email = (this.data.invoiceEmail || '').trim();
    if (!title) { wx.showToast({ title: cn ? '请填写发票抬头' : 'Enter the invoice title', icon: 'none' }); return; }
    if (this.data.invoiceType === 'company' && !taxId) { wx.showToast({ title: cn ? '请填写企业税号' : 'Enter the tax ID', icon: 'none' }); return; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { wx.showToast({ title: cn ? '请填写有效邮箱' : 'Enter a valid email', icon: 'none' }); return; }
    this.setData({ invoiceBusy: true });
    try {
      await api.post('/api/retail/orders/' + this.data.id + '/invoice-request', {
        invoice_type:   this.data.invoiceType,
        invoice_title:  title,
        invoice_tax_id: this.data.invoiceType === 'company' ? taxId : null,
        invoice_email:  email,
      });
      wx.showToast({ title: cn ? '发票已申请 ✓' : 'Invoice requested ✓', icon: 'success' });
      this.setData({ invoiceSheetOpen: false });
      await this.refresh();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ invoiceBusy: false });
    }
  },
  onRefundModeTap(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === this.data.refundMode) return;
    const o = this.data.order || {};
    const total = Number(o.total) || 0;
    if (mode === 'full') this.setData({ refundMode: 'full', refundAmount: total.toFixed(2) });
    else this.setData({ refundMode: mode });
  },
  onRefundAmountInput(e) {
    this.setData({ refundAmount: e.detail.value });
  },
  onRefundReasonInput(e) {
    this.setData({ refundReason: e.detail.value });
  },
  onRefundLineToggle(e) {
    const idx = e.currentTarget.dataset.idx;
    const lines = this.data.refundLines.slice();
    const ln = { ...lines[idx], picked: !lines[idx].picked };
    ln.amount = ln.picked ? +(ln.unit * ln.refund_qty).toFixed(2) : 0;
    ln.amount_disp = '¥' + ln.amount.toFixed(2);
    lines[idx] = ln;
    this.setData({ refundLines: lines });
    this.recalcLinesTotal();
  },
  onRefundLineQty(e) {
    const idx = e.currentTarget.dataset.idx;
    const raw = Number(e.detail.value) || 0;
    const lines = this.data.refundLines.slice();
    const q = Math.max(0, Math.min(raw, lines[idx].max_qty));
    const ln = { ...lines[idx], refund_qty: q };
    if (ln.picked) {
      ln.amount = +(ln.unit * q).toFixed(2);
      ln.amount_disp = '¥' + ln.amount.toFixed(2);
    }
    lines[idx] = ln;
    this.setData({ refundLines: lines });
    this.recalcLinesTotal();
  },
  recalcLinesTotal() {
    let sum = 0;
    for (const ln of this.data.refundLines) sum += ln.picked ? Number(ln.amount) || 0 : 0;
    this.setData({ refundLinesTotalDisp: '¥' + sum.toFixed(2) });
  },

  async submitRefund() {
    if (this.data.refundBusy) return;
    const mode = this.data.refundMode;
    const body = { reason: this.data.refundReason || '' };
    if (mode === 'lines') {
      const sel = this.data.refundLines
        .filter(l => l.picked && l.refund_qty > 0)
        .map(l => ({ item_id: l.item_id, qty: l.refund_qty }));
      if (!sel.length) {
        wx.showToast({ title: this.data.lang === 'cn' ? '至少选一项' : 'Pick an item', icon: 'none' });
        return;
      }
      body.lines = sel;
    } else if (mode === 'amount') {
      const a = Number(this.data.refundAmount) || 0;
      if (!(a > 0)) {
        wx.showToast({ title: this.data.lang === 'cn' ? '输入金额' : 'Enter amount', icon: 'none' });
        return;
      }
      body.amount = a;
    }
    // mode === 'full' → no amount/lines, server defaults to full total.
    this.setData({ refundBusy: true });
    try {
      await api.post('/api/retail/orders/' + this.data.id + '/refund-request', body);
      wx.showToast({ title: this.data.lang === 'cn' ? '已提交' : 'Submitted', icon: 'success' });
      this.setData({ refundSheetOpen: false });
      await this.refresh();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ refundBusy: false });
    }
  },

  async withdrawRefund() {
    const ok = await new Promise(resolve =>
      wx.showModal({
        title: this.data.copy.refundWithdrawConfirm,
        confirmText: this.data.copy.refundWithdraw,
        cancelText: this.data.lang === 'cn' ? '返回' : 'Back',
        success: r => resolve(r.confirm),
      })
    );
    if (!ok) return;
    try {
      await api.post('/api/retail/orders/' + this.data.id + '/refund-withdraw', {});
      wx.showToast({ title: this.data.lang === 'cn' ? '已撤回' : 'Withdrawn', icon: 'success' });
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
