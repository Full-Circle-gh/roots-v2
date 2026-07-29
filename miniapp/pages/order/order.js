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
    deliveryTrack: null,         // live 青云聚信 courier tracking (same-city e-bike)
    shipments: [],
    etaLabel: '',                // local (same-city) delivery arrival time, e.g. "2:50 PM"
    partialShip: null,           // {line, sub} when some-but-not-all parcels shipped
    airDelay: null,              // {line, sub} when a late air parcel may be unsafe to eat
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
    canAddItems: false,          // "Add to this order" shown while still editable
    copy: {
      title: 'Order',
      statusLabel: 'STATUS',
      shipToLabel: 'SHIP TO',
      collectAtLabel: 'COLLECT AT',
      pickupTimeLabel: 'PICKUP TIME',
      payLabel: 'PAYMENT',
      itemsLabel: 'ITEMS',
      timelineLabel: 'TIMELINE',
      etaLabel: 'Estimated arrival',
      trackingLabel: 'SHIPMENT TRACKING',
      trackingNoEvents: 'Waiting for the first update from the carrier.',
      trackingPending: 'Tracking will appear here shortly.',
      trackingAwaitingNo: 'Shipped — tracking number coming soon.',
      trackingNotShipped: 'This parcel hasn\'t shipped yet — it will follow shortly.',
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
      addToOrderBtn: 'Add to this order',
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
      rescheduleBtnDelivery: 'Change delivery time',
      rescheduleBtnPickup: 'Change pickup time',
      rescheduleTitleDelivery: 'Change delivery time',
      rescheduleTitlePickup: 'Change pickup time',
      rescheduleCurrent: 'Current',
      reschedulePickDate: 'Or pick a date',
      reschedulePickupDate: 'Pickup date',
      reschedulePickupTimeOfDay: 'Pickup time',
      rescheduleConfirm: 'Confirm change',
      rescheduleNoSlots: 'No times available right now.',
      rescheduleFreshHint: 'Your fresh items are already being prepared — message us to change the time 💚',
      rescheduleSaved: 'Time updated ✓',
      addrChangeBtn: 'Change delivery address',
      addrChangeTitle: 'Change delivery address',
      addrChangeCurrent: 'Current address',
      addrChangeConfirm: 'Confirm change',
      addrChangeSaved: 'Address updated ✓',
      addrChangeNone: 'You have no other saved addresses.',
      addrChangeAdd: '+ Add a new address',
      addrChangeOutOfArea: 'Outside this order\'s delivery area — message us to move it 💚',
      addrChangeFeeChange: 'This address changes the delivery fee — message us to move it 💚',
      addrChangeLocked: 'This order is already on its way — message us to change the address 💚',
    },
    // Reschedule (change delivery/pickup time) state
    canReschedule: false,
    rescheduleHint: '',
    rescheduleKind: 'delivery',     // 'delivery' | 'pickup'
    rscSheetOpen: false,
    rscBusy: false,
    rscLoading: false,
    rscCurrentLabel: '',
    rscSlots: [],                   // [{ slot_id, label, kind, surcharge_disp, sel }]
    rscPickedSlot: '',
    rscSchedule: null,              // { min_date, max_date } when a calendar window exists
    rscDate: '',                    // chosen schedule-for-later date (delivery)
    rscPickupDate: '',
    rscPickupTime: '',
    rscPickupWindow: { open: '10:00', close: '20:00' },
    rscErr: '',
    // Change-delivery-address state (server decides the window; see
    // data.address_change on the order payload)
    canChangeAddress: false,
    addrSheetOpen: false,
    addrLoading: false,
    addrBusy: false,
    addrList: [],                   // [{ id, who, full, eligible, is_current, note, sel }]
    addrPicked: null,
    addrErr: '',
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
    // Back from the addresses page mid-change — reopen the sheet so the new
    // address is right there instead of making them find the button again.
    if (this._reopenAddrSheet) {
      this._reopenAddrSheet = false;
      this.openAddressChange();
    }
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
        etaLabel: '预计送达',
        trackingLabel: '物流跟踪',
        trackingNoEvents: '等待承运商首次更新…',
        trackingPending: '物流信息即将更新。',
        trackingAwaitingNo: '已发货 — 运单号即将更新。',
        trackingNotShipped: '此包裹尚未发货 — 稍后寄出。',
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
        addToOrderBtn: '为订单加单',
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
        rescheduleBtnDelivery: '修改配送时间',
        rescheduleBtnPickup: '修改取货时间',
        rescheduleTitleDelivery: '修改配送时间',
        rescheduleTitlePickup: '修改取货时间',
        rescheduleCurrent: '当前',
        reschedulePickDate: '或选择日期',
        reschedulePickupDate: '取货日期',
        reschedulePickupTimeOfDay: '取货时间',
        rescheduleConfirm: '确认修改',
        rescheduleNoSlots: '暂无可选时间。',
        rescheduleFreshHint: '鲜食已在为您备制，如需改期请联系我们 💚',
        rescheduleSaved: '时间已更新 ✓',
        addrChangeBtn: '修改收货地址',
        addrChangeTitle: '修改收货地址',
        addrChangeCurrent: '当前地址',
        addrChangeConfirm: '确认修改',
        addrChangeSaved: '地址已更新 ✓',
        addrChangeNone: '暂无其他已保存的地址。',
        addrChangeAdd: '+ 添加新地址',
        addrChangeOutOfArea: '超出本订单的配送区域，如需更改请联系我们 💚',
        addrChangeFeeChange: '该地址会改变配送费，如需更改请联系我们 💚',
        addrChangeLocked: '订单已在配送途中，如需更改地址请联系我们 💚',
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
        // Per-parcel status — shown even before a waybill is attached, so a
        // dispatched-but-untracked parcel still reads as "shipped". A supplier
        // (drop-ship) parcel reads "Awaiting supplier tracking" until its number
        // is entered, since it isn't shipped from our warehouse.
        const stateLabel = s.is_supplier
          ? (L === 'cn'
              ? { pending: '等待供应商发货', dispatched: '已发货', delivered: '已送达' }[s.state]
              : { pending: 'Awaiting supplier shipment', dispatched: 'Shipped', delivered: 'Delivered' }[s.state])
          : (L === 'cn'
              ? { pending: '尚未发货', dispatched: '已发货', delivered: '已送达' }[s.state]
              : { pending: 'Not shipped yet', dispatched: 'Shipped', delivered: 'Delivered' }[s.state]);
        return {
          shipment_id: s.shipment_id,
          is_supplier: !!s.is_supplier,
          label: s.is_supplier
            ? (L === 'cn' ? '供应商直发' : 'Shipped by supplier')
            : (L === 'cn'
                ? `包裹 ${s.index} / ${s.total}`
                : `Package ${s.index} of ${s.total}`),
          state: s.state,
          state_label: stateLabel,
          has_tracking: !!s.has_tracking,
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

      // Late air parcel — a fresh/perishable cold-chain shipment that arrived
      // more than a day late. Surfaced as a persistent food-safety banner so it
      // can't be missed (the in-app notification + push are easy to scroll past).
      // Inform + apologise only; staff handle compensation off-app.
      const airDelay = data.air_delayed
        ? (L === 'cn'
            ? { line: '配送延误送达',
                sub:  '为保障食品安全,请勿食用其中的生鲜或易变质商品。非常抱歉,我们会尽快与您联系。' }
            : { line: 'Your delivery arrived late',
                sub:  "For your safety, please don't eat any fresh or perishable items from this order. We're very sorry — we'll be in touch." })
        : null;

      // Local (same-city / Guangzhou) delivery has no waybill — the store sets a
      // same-day arrival time instead. Surface it as a single label the page
      // shows above the items ("Estimated arrival · 2:50 PM").
      const etaObj = data.delivery_eta || null;
      const etaLabel = etaObj ? (L === 'cn' ? etaObj.label_cn : etaObj.label_en) : '';

      // Pickup orders collect at a store instead of shipping to an address.
      // Build a "Collect at <store>" location string from the store fields
      // carried in address_json (parsed server-side into data.address), and
      // surface the chosen pickup time. order.wxml uses isPickup to swap the
      // delivery address/tracking blocks for pickup equivalents.
      // "Add to this order" eligibility — mirrors the server edit window:
      // status paid|preparing, no parcel shipped, and no refund in flight.
      const shippedAny = shipments.some(s => s.state === 'dispatched' || s.state === 'delivered');
      const refundInFlight = data.refund_status &&
        ['pending', 'reviewing', 'approved', 'paid'].includes(data.refund_status);
      const canAddItems = ['paid', 'preparing'].includes(data.status) && !shippedAny && !refundInFlight;

      // Self-service reschedule (change delivery/pickup time before departure).
      // Eligibility is decided server-side and rides on data.reschedule; we just
      // surface the button when allowed, or a gentle hint when fresh items have
      // locked the time.
      const rsv = data.reschedule || {};
      const canReschedule = !!rsv.allowed;
      const rescheduleKind = rsv.kind === 'pickup' ? 'pickup' : 'delivery';
      const rescheduleHint = (!rsv.allowed && (rsv.reason === 'fresh_cutoff' || rsv.reason === 'fresh_preparing'))
        ? this.data.copy.rescheduleFreshHint
        : '';

      // Change the delivery address — open while the order is unpaid, or paid/
      // preparing with nothing labelled, dispatched, or handed to the courier.
      // Server-decided, same as reschedule.
      const canChangeAddress = !!(data.address_change && data.address_change.allowed);

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
        etaLabel,
        partialShip,
        airDelay,
        trackingEvents,
        trackingEventsVisible,
        refundView,
        canAddItems,
        canReschedule,
        rescheduleKind,
        rescheduleHint,
        canChangeAddress,
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

      // Live courier tracking (青云聚信 same-city e-bike). Only for delivery orders
      // that are out for delivery — fire-and-forget so it never blocks the render,
      // and self-hides when no Qingyun delivery is linked (tracking:false).
      if (!isPickup && ['paid', 'preparing', 'dispatched'].includes(data.status)) {
        this.loadDeliveryTrack();
      } else if (this.data.deliveryTrack) {
        this.setData({ deliveryTrack: null });
      }
    } catch (e) {
      console.warn('[order] load failed:', e.message);
      // A background poll hitting a transient error must not blank a page the
      // user is already reading — only the initial/explicit load shows notFound.
      if (silent) return;
      this.setData({ notFound: true, loading: false });
    }
  },

  // Pull the live courier track (青云聚信) and build the map view-model. Coordinates
  // come back as decimal GCJ-02 — WeChat's <map> default datum — so markers/polyline
  // drop in with no conversion. Hidden (deliveryTrack=null) when nothing is linked.
  async loadDeliveryTrack() {
    const cn = this.data.lang === 'cn';
    try {
      const r = await api.get('/api/retail/orders/' + this.data.id + '/delivery-track');
      const d = r?.data || r;
      if (!d || !d.tracking) { if (this.data.deliveryTrack) this.setData({ deliveryTrack: null }); return; }

      const STAGE = {
        // 'scheduled' = the order is queued for its slot but NO courier is being
        // sought yet — show the map (store → you) with a calm label, never
        // "finding a courier". 'heading_to_pickup' = a rider is assigned and moving
        // but hasn't collected the parcel from the store yet — must not say
        // "On the way" (that's reserved for once they're actually carrying it here).
        scheduled:         cn ? '等待配送'        : 'Delivery scheduled',
        awaiting_dispatch: cn ? '正在为您找骑手'   : 'Finding a courier',
        heading_to_pickup: cn ? '骑手正在取货'     : 'Rider picking up your order',
        in_transit:        cn ? '骑手配送中'      : 'On the way',
        delivered:         cn ? '已送达'          : 'Delivered',
      };
      const mk = (pos, text, who, id) => ({
        id, latitude: pos.lat, longitude: pos.lng, width: 22, height: 22,
        callout: { content: text, display: 'ALWAYS', padding: 6, borderRadius: 8,
                   bgColor: who === 'rider' ? '#E96174' : '#FFFFFF',
                   color: who === 'rider' ? '#FFFFFF' : '#1A1A1A', fontSize: 11 },
      });
      const markers = [];
      const incl = [];
      if (d.shop_position)      { markers.push(mk(d.shop_position,      cn ? '门店' : 'Store', 'shop', 1)); incl.push(d.shop_position); }
      if (d.recipient_position) { markers.push(mk(d.recipient_position, cn ? '收货' : 'You',   'dest', 2)); incl.push(d.recipient_position); }
      if (d.rider_position)     { markers.push(mk(d.rider_position,     cn ? '骑手' : 'Rider', 'rider', 3)); incl.push(d.rider_position); }

      const polyline = (Array.isArray(d.route) && d.route.length > 1) ? [{
        points: d.route.map(p => ({ latitude: p.lat, longitude: p.lng })),
        color: '#E96174CC', width: 5, arrowLine: true,
      }] : [];
      const center = d.rider_position || d.recipient_position || d.shop_position || null;
      const includePoints = incl.map(p => ({ latitude: p.lat, longitude: p.lng }));

      // Sub-line: rider name · distance · ETA (only the parts we have).
      const parts = [];
      if (d.rider && d.rider.name) parts.push(d.rider.name);
      if (d.rider_to_cust_m != null) parts.push((d.rider_to_cust_m / 1000).toFixed(1) + (cn ? 'km' : ' km'));
      // eta_seconds is time-to-the-STORE while heading_to_pickup (not yet collected),
      // so only surface it as "arriving in ~N min" once truly in_transit to the
      // customer — otherwise a rider still walking into the shop reads as seconds away.
      if (d.eta_seconds != null && d.stage === 'in_transit') {
        const min = Math.max(1, Math.round(d.eta_seconds / 60));
        parts.push(cn ? ('约 ' + min + ' 分钟') : ('~' + min + ' min'));
      }
      // Pre-dispatch: no rider/ETA — the sub-line shows the chosen slot instead.
      const subLine = d.stage === 'scheduled'
        ? (d.slot_label || (cn ? '按预约时间送达' : 'At your scheduled time'))
        : parts.join(cn ? ' · ' : ' · ');

      this.setData({
        deliveryTrack: {
          stage: d.stage,
          stageLabel: STAGE[d.stage] || (cn ? '配送中' : 'On the way'),
          carrier: d.stage === 'scheduled' ? '' : (d.carrier || ''),
          waybill: d.waybill_id || '',
          rider: d.rider || null,
          subLine,
          hasMap: !!center && d.stage !== 'delivered',
          center, markers, polyline, includePoints,
          mapLabel: d.stage === 'scheduled' ? (cn ? '配送信息' : 'DELIVERY') : (cn ? '配送追踪' : 'LIVE TRACKING'),
          callLabel: cn ? '联系骑手' : 'Call rider',
        },
      });
    } catch (e) {
      // A tracking hiccup must never blank the order page — just skip this round.
      console.warn('[order] delivery-track load failed:', e.message);
    }
  },

  // Call the courier (青云聚信 rider). Phone comes from the live track payload.
  callRider() {
    const t = this.data.deliveryTrack;
    if (!t || !t.rider || !t.rider.phone) return;
    wx.makePhoneCall({ phoneNumber: String(t.rider.phone), fail: () => {} });
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

  // Open the full tracking page for one parcel of a split-package order.
  openShipmentLink(e) {
    const o = this.data.order || {};
    const n = e.currentTarget.dataset.number || '';
    if (!o.order_no || !n) return;
    wx.navigateTo({
      url: `/pages/track/track?order_no=${encodeURIComponent(o.order_no)}&number=${encodeURIComponent(n)}`,
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

  // Open the full editorial tracking page — now a NATIVE page (pages/track),
  // which fetches the carrier events as JSON over the request domain and
  // renders them in-app. No <web-view>, so no 业务域名 / ICP dependency.
  // Fallback: if wx.navigateTo fails for any reason (older mini-app
  // version, missing page, etc.) we copy the tracking number so the
  // customer can paste it into the JD app instead.
  openCarrierLink() {
    const o = this.data.order || {};
    const t = this.data.tracking || {};
    if (!o.order_no || !t.number) return;
    wx.navigateTo({
      url: `/pages/track/track?order_no=${encodeURIComponent(o.order_no)}&number=${encodeURIComponent(t.number)}`,
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

  // "Forgot something?" — open the self-contained add-to-order picker. On the
  // way back, onShow's refresh repulls the order so the new items appear.
  addToOrder() {
    wx.navigateTo({ url: '/pages/add-to-order/add-to-order?order_id=' + this.data.id });
  },

  // ─── Reschedule flow (change delivery/pickup time before departure) ───────
  // Open the sheet and load this order's slot options (the same windows the
  // checkout offers, for the order's own zone — or the pickup window for
  // collection orders). Price-neutral: a surcharge-changing pick is refused by
  // the server and surfaced as "message us".
  async openReschedule() {
    const cn = this.data.lang === 'cn';
    this.setData({ rscSheetOpen: true, rscLoading: true, rscErr: '', rscSlots: [], rscPickedSlot: '', rscDate: '', rscPickupDate: '', rscPickupTime: '', rscSchedule: null });
    try {
      const r = await api.get('/api/retail/orders/' + this.data.id + '/reschedule-options');
      const d = r?.data || r;
      if (!d || !d.eligibility || !d.eligibility.allowed) {
        this.setData({ rscLoading: false, rscErr: this.data.copy.rescheduleFreshHint });
        return;
      }
      const cur = (d.current && d.current.slot_label) || '';
      if (d.fulfillment_type === 'pickup') {
        this.setData({
          rscLoading: false,
          rscCurrentLabel: cur,
          rscPickupWindow: d.pickup_window || { open: '10:00', close: '20:00' },
        });
      } else {
        const sc = d.scheduling || {};
        const slots = (Array.isArray(sc.slots) ? sc.slots : []).map(s => ({
          slot_id: s.slot_id,
          kind: s.slot_kind || (s.is_same_day ? 'today' : 'schedule'),
          label: cn ? (s.label_cn || s.label_en) : (s.label_en || s.label_cn),
          surcharge_disp: Number(s.surcharge) > 0 ? (' (+¥' + Number(s.surcharge).toFixed(2) + ')') : '',
          sel: false,
        }));
        this.setData({
          rscLoading: false,
          rscCurrentLabel: cur,
          rscSlots: slots,
          rscSchedule: sc.schedule || null,
        });
      }
    } catch (e) {
      this.setData({ rscLoading: false, rscErr: cn ? '无法加载，请稍后再试。' : 'Could not load options.' });
    }
  },
  closeRescheduleSheet() {
    if (this.data.rscBusy) return;
    this.setData({ rscSheetOpen: false });
  },
  onRescheduleMaskTap() { this.closeRescheduleSheet(); },
  // Pick one of the soonest slot chips — clears any calendar date pick.
  pickRscSlot(e) {
    const id = e.currentTarget.dataset.id;
    const slots = this.data.rscSlots.map(s => ({ ...s, sel: s.slot_id === id }));
    this.setData({ rscSlots: slots, rscPickedSlot: id, rscDate: '', rscErr: '' });
  },
  // Schedule-for-later calendar pick (delivery) — clears any chip selection.
  onRscDateChange(e) {
    const slots = this.data.rscSlots.map(s => ({ ...s, sel: false }));
    this.setData({ rscDate: e.detail.value, rscSlots: slots, rscPickedSlot: '', rscErr: '' });
  },
  onRscPickupDateChange(e) { this.setData({ rscPickupDate: e.detail.value, rscErr: '' }); },
  onRscPickupTimeChange(e) { this.setData({ rscPickupTime: e.detail.value, rscErr: '' }); },
  async confirmReschedule() {
    if (this.data.rscBusy) return;
    const cn = this.data.lang === 'cn';
    const isPickup = this.data.rescheduleKind === 'pickup';
    let payload;
    if (isPickup) {
      if (!this.data.rscPickupDate || !this.data.rscPickupTime) {
        this.setData({ rscErr: cn ? '请选择取货日期和时间。' : 'Pick a date and time.' });
        return;
      }
      payload = { pickup_time: this.data.rscPickupDate + 'T' + this.data.rscPickupTime };
    } else {
      const slotId = this.data.rscPickedSlot || this.data.rscDate;
      if (!slotId) {
        this.setData({ rscErr: cn ? '请选择一个时间。' : 'Pick a time.' });
        return;
      }
      payload = { delivery_slot_id: slotId };
      if (this.data.rscPickedSlot) {
        const s = this.data.rscSlots.find(x => x.slot_id === slotId);
        if (s && s.kind) payload.delivery_slot_kind = s.kind;
        if (s && s.label) payload.delivery_slot_label = s.label;
      } else {
        payload.delivery_slot_kind = 'schedule';
        payload.delivery_slot_label = (cn ? '配送 ' : 'Deliver ') + slotId;
      }
    }
    this.setData({ rscBusy: true, rscErr: '' });
    try {
      await api.post('/api/retail/orders/' + this.data.id + '/reschedule', payload);
      this.setData({ rscBusy: false, rscSheetOpen: false });
      wx.showToast({ title: this.data.copy.rescheduleSaved, icon: 'success' });
      await this.refresh(true);
    } catch (e) {
      this.setData({ rscBusy: false, rscErr: this._rescheduleErrText(e) });
    }
  },
  // Map a server error (api.post throws an Error with .message = error string)
  // to friendly copy. The server's price-neutral + fresh guards live here.
  _rescheduleErrText(e) {
    const cn = this.data.lang === 'cn';
    const m = (e && (e.code || e.message)) || '';
    if (/price_change/.test(m))     return cn ? '该时段会改变费用，请联系我们。' : 'That time changes the price — message us to switch.';
    if (/fresh_no_sameday/.test(m)) return cn ? '鲜食无法改到当天，请选其他日期。' : 'Fresh items can’t move to a same-day slot — pick a later date.';
    if (/not_reschedulable/.test(m))return this.data.copy.rescheduleFreshHint;
    if (/slot_/.test(m))            return cn ? '请选择有效的时间。' : 'Please pick a valid time.';
    if (/pickup_time/.test(m))      return cn ? '请选择营业时间内的取货时间。' : 'Pick a time within opening hours.';
    return cn ? '修改失败，请重试。' : 'Could not change the time. Please try again.';
  },

  // ─── Change delivery address (before the parcel is committed) ─────────────
  // Shaped like the reschedule flow: the server owns the window, we list the
  // customer's saved addresses and mark which ones keep this order in the same
  // delivery area. A cross-area address is shown but not pickable — moving it
  // would re-price and re-route the order, so that one goes through us.
  async openAddressChange() {
    const cn = this.data.lang === 'cn';
    this.setData({ addrSheetOpen: true, addrLoading: true, addrErr: '', addrList: [], addrPicked: null });
    try {
      const r = await api.get('/api/retail/orders/' + this.data.id + '/address-options');
      const d = r?.data || r;
      if (!d || !d.eligibility || !d.eligibility.allowed) {
        this.setData({ addrLoading: false, addrErr: this.data.copy.addrChangeLocked });
        return;
      }
      const copy = this.data.copy;
      const list = (Array.isArray(d.addresses) ? d.addresses : []).map(a => ({
        id: a.id,
        who: [a.recipient_name, a.phone].filter(Boolean).join(' · '),
        full: a.address_full || '',
        // The order's own address is listed for orientation, not as a choice.
        eligible: !!a.eligible && !a.is_current,
        is_current: !!a.is_current,
        note: a.is_current ? copy.addrChangeCurrent : this._addrReasonText(a.reason),
        sel: false,
      }));
      this.setData({ addrLoading: false, addrList: list });
    } catch (e) {
      this.setData({
        addrLoading: false,
        addrErr: cn ? '无法加载地址，请稍后再试。' : 'Could not load your addresses.',
      });
    }
  },
  closeAddressSheet() {
    if (this.data.addrBusy) return;
    this.setData({ addrSheetOpen: false });
  },
  onAddressMaskTap() { this.closeAddressSheet(); },
  pickAddress(e) {
    const id = e.currentTarget.dataset.id;
    const row = this.data.addrList.find(a => a.id === id);
    if (!row || !row.eligible) return;
    this.setData({
      addrList: this.data.addrList.map(a => ({ ...a, sel: a.id === id })),
      addrPicked: id,
      addrErr: '',
    });
  },
  // Adding/editing lives on the addresses page. Flag the sheet to reopen on the
  // way back so a freshly-added address is one tap from being used.
  goAddAddress() {
    this._reopenAddrSheet = true;
    this.setData({ addrSheetOpen: false });
    wx.navigateTo({ url: '/pages/addresses/addresses' });
  },
  async confirmAddressChange() {
    if (this.data.addrBusy) return;
    const cn = this.data.lang === 'cn';
    if (!this.data.addrPicked) {
      this.setData({ addrErr: cn ? '请选择一个地址。' : 'Pick an address.' });
      return;
    }
    this.setData({ addrBusy: true, addrErr: '' });
    try {
      await api.post('/api/retail/orders/' + this.data.id + '/address', {
        address_id: this.data.addrPicked,
      });
      this.setData({ addrBusy: false, addrSheetOpen: false });
      wx.showToast({ title: this.data.copy.addrChangeSaved, icon: 'success' });
      await this.refresh(true);
    } catch (e) {
      this.setData({ addrBusy: false, addrErr: this._addressErrText(e) });
    }
  },
  // Why an address can't be used, in customer words. route_change = it ships a
  // different way (other side of the Guangzhou / ship-district split);
  // price_change = same path, different delivery fee.
  _addrReasonText(reason) {
    if (reason === 'route_change') return this.data.copy.addrChangeOutOfArea;
    if (reason === 'price_change') return this.data.copy.addrChangeFeeChange;
    return '';
  },
  // not_changeable means the order moved on while the sheet was open.
  _addressErrText(e) {
    const cn = this.data.lang === 'cn';
    const m = (e && (e.code || e.message)) || '';
    if (/route_change/.test(m))   return this.data.copy.addrChangeOutOfArea;
    if (/price_change/.test(m))   return this.data.copy.addrChangeFeeChange;
    if (/not_changeable/.test(m)) return this.data.copy.addrChangeLocked;
    if (/address_(not_found|required)/.test(m)) return cn ? '请选择一个地址。' : 'Pick an address.';
    return cn ? '修改失败，请重试。' : 'Could not change the address. Please try again.';
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
