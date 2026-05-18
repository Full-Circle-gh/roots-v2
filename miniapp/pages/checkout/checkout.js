// Checkout — collects address + delivery + payment method, places order,
// initiates payment. In DEV mode the payment auto-succeeds and we route
// straight to /pages/order-success. In PROD mode (real WeChat Pay):
// wx.requestPayment is invoked with the server-returned params.

const api    = require('../../utils/api');
const cart   = require('../../utils/cart');
const config = require('../../utils/config');
const lang   = require('../../utils/lang');
const notify = require('../../utils/notifications');

Page({
  data: {
    items: [],
    subtotal: 0,
    deliveryFee: 0,
    packingFee: 0,
    freeShipping: false,
    pointsEarnedPreview: 0,
    zone: null,              // { name_cn, name_en, supports_max, max_fee, ... } from /quote
    zoneError: '',           // 'no_zone_match' | '' — populated when the address isn't covered
    kitchenAddress: '',      // shown in the no-zone-match message
    quoting: false,          // suppresses spam-clicks while a quote is in flight
    total: 0,
    voucherCode: '',         // applied code (uppercase)
    voucherDiscount: 0,      // ¥ off
    voucherFreeShip: false,  // if voucher is free-shipping type
    voucherInput: '',        // text being typed (not applied yet)
    publicCoupons: [],       // [{code, title, sublabel}]
    myVouchers: [],          // granted to this customer
    showCodeInput: false,    // collapses the type-a-code row until tapped
    deliveryMethod: 'standard',  // 'standard' | 'max' — 'sameday' kept as legacy fallback
    paymentMethod: 'wechat',     // 'wechat' | 'alipay' | 'points'
    pointsBalance: 0,            // customer's available points (drives Points option visibility)
    pointsValue: '0.00',         // ¥ value of the balance (display only)
    pointsRequired: 0,           // points needed to pay this order entirely
    pointsAffordable: false,     // balance covers requirement — gates the Points radio
    // Delivery scheduling — populated by the /quote response.
    scheduling: null,            // full scheduling object from server (slots, surcharge, hours)
    deliverySlotId: '',          // 'right_away' | 'YYYY-MM-DD' | 'YYYY-MM-DDTHH:MM' — required before placeOrder
    deliverySlotLabel: '',       // human-readable label for the picked slot (passed back to server)
    deliverySurcharge: 0,        // ¥ same-day surcharge for the picked slot
    slotsByDay: [],              // [{date_iso, day_label_en, day_label_cn, slots: [...]}] grouped for UI (time-slot mode)
    // Day-only mode (Panyu-style) — three radio options below the address.
    selectedSlotKind: '',        // 'express' | 'today' | 'schedule'
    hasTodayOption: false,       // shown only when zone has same-day surcharge AND today is in slots
    expressLabel: '',            // localized headline for the default option
    expressSub: '',              // localized sub-line
    // Fulfillment routing — when the nearest store is short of stock and a
    // farther one can fulfill, the server marks the quote with
    // `needs_fallback_confirmation`. We pre-warn the customer with a banner
    // and ask for explicit consent in a modal before submitting the order.
    routing: null,               // full routing block from /quote — { ok, store_name_*, needs_fallback_confirmation?, nearest?, fallback? }
    needsFallback: false,        // shortcut: routing.needs_fallback_confirmation === true
    fallbackStoreName: '',       // display name of the farther store (localized)
    nearestStoreName: '',        // display name of the (out-of-stock) nearest store (localized)
    acceptedFallback: false,     // user clicked "Yes, ship from farther store" — sent as accept_fallback:true on /orders
    showFallbackModal: false,    // toggles the custom in-page modal (replaces wx.showModal so we can brand it)
    scheduleMinDate: '',         // <picker mode="date"> start bound (YYYY-MM-DD)
    scheduleMaxDate: '',         // <picker mode="date"> end bound (YYYY-MM-DD)
    schedulePickedDate: '',      // last date the customer picked from the calendar
    schedulePickedLabel: '',     // pretty label for the picked date ('Tue, May 19')
    itemCount: 0,                // sum of qty across cart items (shown next to "YOUR ORDER")
    savedAddresses: [],          // [{id, recipient_name, phone, address, ...}]
    pickerOpen: false,           // true once user taps CHANGE; defaults closed so collapsed view shows
    showNewForm: false,          // true when user wants to type a fresh address
    address: {
      id: null,
      recipient_name: '',
      phone: '',
      address: '',
      detail: '',
      city: '',
      district: '',
    },
    note: '',
    needsCutlery: false,
    needsInvoice: false,
    placing: false,
    lang: 'en',
    copy: {
      kicker: 'CHECKOUT · 结账',
      title: 'Where & how.',
      // Receipt-style section labels (kicker-styled, uppercase)
      orderSummary: 'YOUR ORDER',
      // Bear Serif section titles (match design's "Deliver to" / "How fast" / "Pay with")
      shipToTitle: 'Deliver to',
      howFastTitle: 'How fast',
      payWithTitle: 'Pay with',
      addOnsTitle: 'Add-ons',
      couponsTitle: 'Coupons',
      placeOrder: 'PLACE ORDER →',
      pay: 'PAY',
      name: 'Name',
      phone: 'Phone',
      addr: 'Address',
      detailPlaceholder: 'Floor / unit / apartment (optional)',
      cutlery: 'Include cutlery',
      invoice: 'Need an invoice',
      noteLabel: 'Note for the kitchen (optional)',
      standardOpt: 'Standard',
      sameDayOpt: 'Same-day',
      maxOpt: 'MAX',
      cityPlaceholder: 'City',
      districtPlaceholder: 'District',
      wechatOpt: 'WeChat Pay',
      alipayOpt: 'Alipay',
      pointsOpt: 'Points',
      free: 'FREE',
    },
  },

  async onLoad() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.applyLangCopy();

    const state = cart.get();
    if (!state.items.length) {
      wx.showToast({ title: this.data.lang === 'cn' ? '购物车空空如也' : 'Your cart is empty', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/cart/cart' }), 800);
      return;
    }

    // Profile-binding gate. The order flow needs a real customer name —
    // if the customer hasn't bound their WeChat nickname yet, route them
    // to the profile page first. Cart.js gates this too, but checkout is
    // reachable via deep-links so we re-check here.
    const cust = app.globalData.customer || {};
    if (!cust.nickname) {
      wx.showToast({
        title: this.data.lang === 'cn' ? '请先绑定资料' : 'Please bind your profile first',
        icon: 'none',
      });
      setTimeout(() => wx.redirectTo({ url: '/pages/profile/profile' }), 800);
      return;
    }

    // Stash the kitchen address for the "we don't deliver here" message.
    try {
      const cfg = await config.load();
      this.setData({ kitchenAddress: cfg?.delivery?.kitchenAddress || '' });
    } catch {}

    // Load saved addresses — pick the default (or first) as the initial
    // selection. If the user has 0 saved, fall through to the inline form.
    try {
      const addrs = await api.get('/api/retail/addresses');
      const list = Array.isArray(addrs) ? addrs : addrs?.data || [];
      const def = list.find(a => a.is_default) || list[0] || null;
      this.setData({
        savedAddresses: list,
        showNewForm: list.length === 0,
      });
      if (def) {
        this.setData({
          address: {
            id: def.id,
            recipient_name: def.recipient_name || '',
            phone: def.phone || '',
            address: def.address || '',
            detail: def.detail || '',
            city: def.city || '',
            district: def.district || '',
          },
        });
      }
    } catch {}

    this.refreshQuote();
    this.loadPublicCoupons();
    this.loadPointsBalance();

    // If the user tapped "Use Now" on a coupon from /pages/coupons, the
    // code was stashed in storage on the way over. Apply it now.
    try {
      const pending = wx.getStorageSync('pending_voucher_code');
      if (pending) {
        wx.removeStorageSync('pending_voucher_code');
        this.setData({ voucherInput: String(pending).toUpperCase() });
        this.applyVoucher();
      }
    } catch {}
  },

  async loadPublicCoupons() {
    try {
      const L = this.data.lang;
      const fmt = (v) => {
        const title = lang.pick(v.title_en, v.title_cn, L)
          || (v.type === 'percent'        ? (v.value + '% off')
           :  v.type === 'free_shipping'  ? (L === 'cn' ? '免运费' : 'Free shipping')
                                          : ('¥' + Number(v.value).toFixed(0) + ' off'));
        const subBits = [];
        if (v.min_subtotal > 0) {
          subBits.push((L === 'cn' ? '满 ¥' : 'Min ¥') + Number(v.min_subtotal).toFixed(0));
        }
        if (v.expires_at) {
          subBits.push((L === 'cn' ? '至 ' : 'Until ') + String(v.expires_at).slice(0, 10));
        }
        return { code: v.code, title, sublabel: subBits.join(' · ') };
      };
      const [pubRes, mineRes] = await Promise.all([
        api.get('/api/retail/vouchers/public').catch(() => []),
        api.get('/api/retail/my-vouchers').catch(() => []),
      ]);
      // api.js unwraps body.data → resolves to the array directly. Guard
      // for both shapes just in case some endpoint returns the envelope.
      const unwrap = (x) => Array.isArray(x) ? x : (x?.data || []);
      const pub  = unwrap(pubRes).map(fmt);
      const mine = unwrap(mineRes).map(fmt);
      this.setData({ publicCoupons: pub, myVouchers: mine });
    } catch (e) {
      console.warn('[checkout] loadPublicCoupons failed:', e.message);
    }
  },

  async loadPointsBalance() {
    try {
      const me = await api.get('/api/retail/customer');
      const data = me?.data || me || {};
      const bal = Number(data.points_balance) || 0;
      // Display value uses config'd points.redeemRate (default 100 pts = ¥1).
      // We don't have the rate client-side; fall back to /100 which matches
      // the seeded default. The figure is preview-only.
      this.setData({
        pointsBalance: bal,
        pointsValue: (bal / 100).toFixed(2),
      });
    } catch (e) { /* not signed in / no profile — silently skip Points option */ }
  },

  openPicker() {
    this.setData({ pickerOpen: true });
  },

  selectPublicCoupon(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    this.setData({ voucherInput: code });
    this.applyVoucher();
  },

  toggleCodeInput() {
    this.setData({ showCodeInput: !this.data.showCodeInput });
  },

  applyLangCopy() {
    const L = this.data.lang;
    if (L !== 'cn') return;
    this.setData({
      copy: {
        kicker: '结账',
        title: '送到何处？',
        orderSummary: '您的订单',
        shipToTitle: '送货地址',
        howFastTitle: '配送方式',
        payWithTitle: '支付方式',
        addOnsTitle: '附加',
        couponsTitle: '优惠券',
        placeOrder: '提交订单 →',
        pay: '应付',
        name: '收件人',
        phone: '电话',
        addr: '地址',
        detailPlaceholder: '楼层 / 单元 / 公寓 (可选)',
        cutlery: '需要餐具',
        invoice: '需要发票',
        noteLabel: '给厨房的备注 (可选)',
        standardOpt: '标准配送',
        sameDayOpt: '当日达',
        maxOpt: '极速达',
        cityPlaceholder: '城市',
        districtPlaceholder: '区',
        wechatOpt: '微信支付',
        alipayOpt: '支付宝',
        pointsOpt: '积分抵扣',
        free: '免费',
      },
    });
  },

  // Recomputes the displayed totals. Always renders the items + subtotal
  // immediately (so the UI doesn't blink to empty), then fires off a server
  // quote in the background and patches the fee fields when it lands. The
  // server is the source of truth for the zone-driven delivery + packing fees.
  refreshQuote() {
    const state = cart.get();
    const subtotal = cart.subtotal();
    const L = this.data.lang;
    const items = state.items.map(it => ({
      ...it,
      display_name: lang.pick(it.name_en, it.name_cn, L),
      line_total: '¥' + (it.unit_price * it.qty).toFixed(2),
    }));
    const itemCount = state.items.reduce((s, it) => s + (it.qty || 0), 0);
    this.setData({ items, itemCount, subtotal: subtotal.toFixed(2) });

    // Need an address (saved id or inline city/district) before the server
    // can match a zone. If we have neither, leave the fee fields at 0 and
    // let placeOrder surface the address-required toast.
    const a = this.data.address || {};
    const hasSaved  = !!a.id;
    const hasInline = !!(a.city || a.district);
    if (!hasSaved && !hasInline) {
      this.applyQuoteFallback(subtotal);
      return;
    }

    const orderItems = state.items.map(it => ({
      product_id: it.product_id,
      qty: it.qty,
      choices: (it.options || []).map(o => o.choice_id).filter(Boolean),
    }));

    const body = {
      items: orderItems,
      delivery_mode: this.data.deliveryMethod,
      payment_method: this.data.paymentMethod,
    };
    if (hasSaved) body.address_id = a.id;
    else          body.address    = { city: a.city, district: a.district };

    this.setData({ quoting: true });
    api.post('/api/retail/checkout/quote', body)
      .then(resp => {
        const data = resp?.data || resp || {};
        // The endpoint returns { success: false, error: 'no_zone_match', data } when
        // no zone matches. api.js may surface that as a thrown error OR as a
        // resolved value depending on the helper — defensively handle both.
        const deliveryFee = Number(data.delivery_fee) || 0;
        const packingFee  = Number(data.packing_fee)  || 0;
        let effectiveDelivery = deliveryFee;
        if (this.data.voucherFreeShip) effectiveDelivery = 0;
        const voucherDiscount = Number(this.data.voucherDiscount) || 0;
        const grossTotal = Math.max(0, subtotal + effectiveDelivery + packingFee - voucherDiscount);
        const payingWithPoints = this.data.paymentMethod === 'points' && data.points_affordable;
        const total = payingWithPoints ? 0 : grossTotal;
        // Group slots by date for the UI. Server returns a flat list; we
        // bucket by date_iso so the wxml can render a "day → slots" tree.
        const sch = data.scheduling || null;
        const slotsByDay = this.buildSlotGroups(sch);
        // Reconcile the previously-picked slot. If the saved slotId is no
        // longer in the fresh list (zone changed, day rolled over, etc.),
        // clear it so the customer is forced to pick again.
        const validSlotIds = new Set(['right_away', ...((sch?.slots || []).map(s => s.slot_id))]);
        const stillValid = this.data.deliverySlotId && validSlotIds.has(this.data.deliverySlotId);
        const nextSlotId    = stillValid ? this.data.deliverySlotId    : '';
        const nextSlotLabel = stillValid ? this.data.deliverySlotLabel : '';
        const nextSlotSurcharge = stillValid ? this.data.deliverySurcharge : 0;
        const totalWithSurcharge = Math.max(0, (Number(total) || 0) + nextSlotSurcharge);
        // Routing info — drives the "ships from farther store, longer wait?"
        // banner + modal. Reset acceptedFallback when the situation changes
        // (e.g. address swap that moves us back to nearest-in-stock).
        const routing = data.routing || null;
        const needsFallback = !!(routing && routing.needs_fallback_confirmation);
        const fallbackStoreName = needsFallback
          ? (this.data.lang === 'cn'
              ? (routing.fallback?.store_name_cn || routing.fallback?.store_name_en || '')
              : (routing.fallback?.store_name_en || routing.fallback?.store_name_cn || ''))
          : '';
        const nearestStoreName = needsFallback
          ? (this.data.lang === 'cn'
              ? (routing.nearest?.store_name_cn || routing.nearest?.store_name_en || '')
              : (routing.nearest?.store_name_en || routing.nearest?.store_name_cn || ''))
          : '';
        const keepAccepted = this.data.acceptedFallback && needsFallback
          && this.data.routing?.fallback?.store_id === routing?.fallback?.store_id;
        this.setData({
          zone: data.zone || null,
          zoneError: '',
          deliveryFee: effectiveDelivery.toFixed(2),
          packingFee:  packingFee.toFixed(2),
          freeShipping: !!data.free_shipping,
          pointsEarnedPreview: Number(data.points_earned_preview) || 0,
          pointsRequired:    Number(data.points_required) || 0,
          pointsAffordable:  !!data.points_affordable,
          scheduling: sch,
          slotsByDay,
          deliverySlotId: nextSlotId,
          deliverySlotLabel: nextSlotLabel,
          deliverySurcharge: nextSlotSurcharge,
          total: totalWithSurcharge.toFixed(2),
          quoting: false,
          routing,
          needsFallback,
          fallbackStoreName,
          nearestStoreName,
          acceptedFallback: keepAccepted,
        });
        // Day-only mode: configure the three-option picker (Express / Today /
        // Schedule for later) and auto-select Express if there's no prior pick.
        if (sch?.mode === 'day_only') {
          this.applyDayOnlyDefaults(!stillValid);
        } else {
          // Time-slot mode: surface the server's schedule-window bounds so
          // the <picker mode="date"> can offer "schedule for later".
          const minDate = sch?.schedule?.min_date || '';
          const maxDate = sch?.schedule?.max_date || '';
          this.setData({ scheduleMinDate: minDate, scheduleMaxDate: maxDate });
        }
      })
      .catch(err => {
        const code = err?.message || '';
        if (code === 'no_zone_match' || code === 'max_not_offered') {
          this.setData({
            zone: null,
            zoneError: code,
            deliveryFee: '0.00',
            packingFee: '0.00',
            freeShipping: false,
            total: subtotal.toFixed(2),
            quoting: false,
          });
        } else {
          // Network / unknown — keep the user able to place an order; the
          // server-side /orders endpoint will refuse on its own if invalid.
          console.warn('[checkout] /quote failed:', code);
          this.applyQuoteFallback(subtotal);
        }
      });
  },

  // Group the server's flat slot list into `[{date_iso, day_label, slots: [...]}]`
  // for the time-slot UI. Day-only mode returns one "group" per day with the
  // day name as the chip label (no hour ranges), so the wxml renders a flat
  // chip strip instead.
  buildSlotGroups(sch) {
    if (!sch || !Array.isArray(sch.slots)) return [];
    const L = this.data.lang;
    const isDayOnly = sch.mode === 'day_only';
    const byDate = new Map();
    for (const s of sch.slots) {
      const dayLabel = L === 'cn' ? s.label_cn : s.label_en;
      const dayHead  = L === 'cn' ? s.label_cn.split(' ')[0] : s.label_en.split(' ')[0];
      if (!byDate.has(s.date_iso)) {
        byDate.set(s.date_iso, {
          date_iso: s.date_iso,
          day_label: dayHead,
          is_same_day: !!s.is_same_day,
          slots: [],
        });
      }
      // In day-only mode each "slot" represents the whole day. The chip
      // label shows the day name (Today/Tomorrow/etc.) plus the surcharge.
      const chipLabel = isDayOnly
        ? dayLabel
        : dayLabel.split(' ').slice(1).join(' ');
      byDate.get(s.date_iso).slots.push({
        ...s,
        chip_label: chipLabel,
        surcharge_label: s.requires_surcharge ? `+¥${Number(s.surcharge).toFixed(0)}` : '',
      });
    }
    return [...byDate.values()];
  },

  // Day-only mode setup — runs after each /quote when scheduling.mode = 'day_only'.
  // Computes which radio options to show, the picker's date range, and a
  // default selection (the earliest non-surcharge slot, i.e. tomorrow).
  applyDayOnlyDefaults(forceDefault) {
    const sch = this.data.scheduling;
    if (!sch || sch.mode !== 'day_only' || !Array.isArray(sch.slots) || !sch.slots.length) {
      this.setData({ hasTodayOption: false, scheduleMinDate: '', scheduleMaxDate: '' });
      return;
    }
    const slots = sch.slots;
    const surcharge = Number(sch.same_day_surcharge) || 0;
    const todaySlot   = slots.find(s => s.is_same_day);
    const expressSlot = slots.find(s => !s.requires_surcharge) || slots[0];
    const hasTodayOption = !!todaySlot && surcharge > 0;
    const L = this.data.lang;

    // Express label: lean on the lead window — if the customer can get it
    // tomorrow that's "1–2 days"; otherwise mention the minimum lead.
    const minLead = Number(sch.min_lead_days) || 0;
    let expressLabel, expressSub;
    if (minLead <= 1) {
      expressLabel = L === 'cn' ? '加急配送(1-2 天)' : 'Express delivery (1–2 days)';
      expressSub   = L === 'cn' ? '根据商品和库存而定'  : 'based on product type and stock availability';
    } else {
      expressLabel = L === 'cn' ? `标准配送(${minLead} 天起)` : `Standard delivery (${minLead}+ days)`;
      expressSub   = L === 'cn' ? '系统将为您安排最早的可用日期' : 'we ship on the earliest available day';
    }

    // "Schedule for later" calendar bounds come from the server's
    // scheduling.schedule object — both modes use the same window now.
    this.setData({
      hasTodayOption,
      scheduleMinDate: sch.schedule?.min_date || '',
      scheduleMaxDate: sch.schedule?.max_date || '',
      expressLabel,
      expressSub,
    });

    // Auto-pick the Express default on first land OR if the previous pick
    // is no longer in the slot list (zone changed, day rolled over).
    if (forceDefault && expressSlot) {
      this.applyDayOnlySlot(expressSlot, 'express');
    }
  },

  // Tap "Express delivery" — synthesizes a slot at the earliest schedule
  // date (schedule.min_date). The server resolves any date inside the
  // schedule window, so we don't need it pre-enumerated.
  pickExpress() {
    const sch = this.data.scheduling || {};
    const min = sch.schedule?.min_date;
    if (!min) return;
    const [y, m, d] = min.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const labelEn = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const labelCn = `${m}月${d}日`;
    this.applyDayOnlySlot({
      slot_id: min,
      date_iso: min,
      is_same_day: false,
      is_day_only: true,
      requires_surcharge: false,
      surcharge: 0,
      label_en: labelEn,
      label_cn: labelCn,
    }, 'express');
  },

  // Tap "Get it today (+¥X)" — picks the day-only today chip (Panyu).
  pickToday() {
    const chip = this.data.scheduling?.today_day_chip
              || (this.data.scheduling?.slots || []).find(x => x.is_same_day);
    if (chip) this.applyDayOnlySlot(chip, 'today');
  },

  // Customer picked a date in the <picker mode="date"> calendar wheel.
  // The server's schedule window covers an open date range, so we don't
  // require the picked date to be enumerated — we synthesize a slot
  // payload that the server's resolveDeliverySlot will accept.
  onScheduleDateChange(e) {
    const picked = e.detail.value;  // 'YYYY-MM-DD'
    const L      = this.data.lang;
    const min    = this.data.scheduleMinDate;
    const max    = this.data.scheduleMaxDate;
    if (min && picked < min || max && picked > max) {
      wx.showToast({
        title: L === 'cn' ? '此日期暂不可选' : 'Date not available',
        icon: 'none',
      });
      return;
    }
    // Pretty label for the chosen date — matches the bilingual format
    // used elsewhere on the checkout page.
    const [y, m, d] = picked.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const labelEn = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const labelCn = `${m}月${d}日`;
    const slot = {
      slot_id: picked,
      date_iso: picked,
      is_same_day: false,
      is_day_only: true,
      requires_surcharge: false,
      surcharge: 0,
      label_en: labelEn,
      label_cn: labelCn,
    };
    this.setData({
      schedulePickedDate: picked,
      schedulePickedLabel: L === 'cn' ? labelCn : labelEn,
    });
    this.applyDayOnlySlot(slot, 'schedule');
  },

  // Shared finalizer for any day-only pick — sets slot id/label/surcharge
  // and recomputes total locally (server already returned the base fees).
  applyDayOnlySlot(slot, kind) {
    const L = this.data.lang;
    const label = L === 'cn' ? slot.label_cn : slot.label_en;
    const surcharge = Number(slot.surcharge) || 0;
    const subtotal = cart.subtotal();
    const deliveryFee = Number(this.data.deliveryFee) || 0;
    const packingFee  = Number(this.data.packingFee)  || 0;
    const voucherDiscount = Number(this.data.voucherDiscount) || 0;
    const payingWithPoints = this.data.paymentMethod === 'points' && this.data.pointsAffordable;
    const gross = Math.max(0, subtotal + deliveryFee + packingFee - voucherDiscount + surcharge);
    const total = payingWithPoints ? 0 : gross;
    this.setData({
      selectedSlotKind: kind,
      deliverySlotId: slot.slot_id,
      deliverySlotLabel: label,
      deliverySurcharge: surcharge,
      total: total.toFixed(2),
    });
  },

  // Customer picked a slot chip. Updates the slot id + label + surcharge
  // and re-runs the local total math (no server round-trip needed since
  // the slot itself doesn't change zone/fee — only the surcharge stacks).
  pickSlot(e) {
    const id        = e.currentTarget.dataset.id;
    const labelEn   = e.currentTarget.dataset.labelEn || '';
    const labelCn   = e.currentTarget.dataset.labelCn || '';
    const surcharge = Number(e.currentTarget.dataset.surcharge) || 0;
    const label     = this.data.lang === 'cn' ? labelCn : labelEn;
    // Recompute total: subtotal + deliveryFee + packingFee − voucherDiscount + slot surcharge.
    const subtotal = cart.subtotal();
    const deliveryFee = Number(this.data.deliveryFee) || 0;
    const packingFee  = Number(this.data.packingFee)  || 0;
    const voucherDiscount = Number(this.data.voucherDiscount) || 0;
    const payingWithPoints = this.data.paymentMethod === 'points' && this.data.pointsAffordable;
    const gross = Math.max(0, subtotal + deliveryFee + packingFee - voucherDiscount + surcharge);
    const total = payingWithPoints ? 0 : gross;
    this.setData({
      deliverySlotId: id,
      deliverySlotLabel: label,
      deliverySurcharge: surcharge,
      total: total.toFixed(2),
    });
  },

  // Used when we can't quote (no address yet, or transient error). Keeps the
  // totals readable by just showing subtotal − voucher.
  applyQuoteFallback(subtotal) {
    const voucherDiscount = Number(this.data.voucherDiscount) || 0;
    this.setData({
      zone: null,
      zoneError: '',
      deliveryFee: '0.00',
      packingFee: '0.00',
      freeShipping: false,
      total: Math.max(0, subtotal - voucherDiscount).toFixed(2),
      quoting: false,
    });
  },

  onVoucherInput(e) {
    this.setData({ voucherInput: (e.detail.value || '').toUpperCase() });
  },

  async applyVoucher() {
    const code = (this.data.voucherInput || '').trim().toUpperCase();
    if (!code) return;
    try {
      const v = await api.post('/api/retail/vouchers/validate', {
        code,
        subtotal: cart.subtotal(),
      });
      const data = v?.data || v;
      this.setData({
        voucherCode: data.code,
        voucherDiscount: Number(data.discount) || 0,
        voucherFreeShip: !!data.free_shipping,
        voucherInput: '',
      });
      this.refreshQuote();
      wx.showToast({
        title: this.data.lang === 'cn' ? '优惠码已应用' : 'Coupon applied',
        icon: 'success',
      });
    } catch (e) {
      const map = {
        not_found:                 this.data.lang === 'cn' ? '优惠码无效' : 'Coupon not found',
        not_applicable:            this.data.lang === 'cn' ? '订单未达使用门槛' : "Doesn't apply yet",
        per_customer_limit_reached:this.data.lang === 'cn' ? '此优惠已使用' : 'Already used',
      };
      wx.showToast({ title: map[e.message] || e.message, icon: 'none' });
    }
  },

  removeVoucher() {
    this.setData({ voucherCode: '', voucherDiscount: 0, voucherFreeShip: false });
    this.refreshQuote();
  },

  onAddrField(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['address.' + field]: e.detail.value });
    // City/district drive the delivery-zone match — re-quote (debounced)
    // when either changes so the user sees their fee adjust live.
    if (field === 'city' || field === 'district') {
      clearTimeout(this._addrQuoteTimer);
      this._addrQuoteTimer = setTimeout(() => this.refreshQuote(), 400);
    }
  },
  selectSaved(e) {
    const id = e.currentTarget.dataset.id;
    const a = this.data.savedAddresses.find(x => x.id === id);
    if (!a) return;
    this.setData({
      showNewForm: false,
      pickerOpen: false,
      address: {
        id: a.id,
        recipient_name: a.recipient_name || '',
        phone: a.phone || '',
        address: a.address || '',
        detail: a.detail || '',
        city: a.city || '',
        district: a.district || '',
      },
    });
    this.refreshQuote();
  },
  showAddNew() {
    // Clear the form so the user types fresh values
    this.setData({
      showNewForm: true,
      pickerOpen: false,
      address: { id: null, recipient_name: '', phone: '', address: '', detail: '', city: '', district: '' },
    });
    this.refreshQuote();
  },
  cancelNew() {
    // Restore selection to the default (or first) saved address
    const list = this.data.savedAddresses;
    const def = list.find(a => a.is_default) || list[0];
    if (def) {
      this.setData({
        showNewForm: false,
        pickerOpen: false,
        address: {
          id: def.id, recipient_name: def.recipient_name, phone: def.phone,
          address: def.address, detail: def.detail || '', city: def.city || '',
          district: def.district || '',
        },
      });
      this.refreshQuote();
    }
  },
  onNoteChange(e)    { this.setData({ note: e.detail.value }); },
  onCutleryToggle(e) { this.setData({ needsCutlery: e.detail.value }); },
  onInvoiceToggle(e) { this.setData({ needsInvoice: e.detail.value }); },
  setDelivery(e) {
    this.setData({ deliveryMethod: e.currentTarget.dataset.method });
    this.refreshQuote();
  },
  setPayment(e) {
    const m = e.currentTarget.dataset.method;
    if (m === 'points') {
      // Points covers the whole order; refuse if balance is short. The
      // /quote endpoint stamps pointsRequired/Affordable based on current
      // total — re-quote first so the latest gross total drives the check.
      const need = this.data.pointsRequired || 0;
      const have = this.data.pointsBalance  || 0;
      if (!this.data.pointsAffordable && need > 0 && have < need) {
        const short = need - have;
        wx.showToast({
          title: this.data.lang === 'cn'
            ? `还差 ${short} 积分`
            : `Need ${short} more points`,
          icon: 'none',
        });
        return;
      }
    }
    this.setData({ paymentMethod: m });
    // Re-quote so the displayed total reflects whether points zero it out.
    this.refreshQuote();
  },

  // Shows the "ship from farther store?" dialog. Returns a Promise<bool>:
  // true → user accepted, caller passes accept_fallback to /orders.
  // Defaults `info` to the cached routing block from the last /quote call;
  // when the order POST itself returns 409 (stock changed between quote
  // and submit) we pass the fresh `info` from the error body. Uses a
  // brand-styled in-page modal (wxml/wxss below) instead of wx.showModal
  // so typography and palette match the rest of the mini-app.
  askFallbackConfirmation(info) {
    const isCN = this.data.lang === 'cn';
    const r = info || this.data.routing;
    if (!r) return Promise.resolve(false);
    const fallbackName = isCN
      ? (r.fallback?.store_name_cn || r.fallback?.store_name_en || '')
      : (r.fallback?.store_name_en || r.fallback?.store_name_cn || '');
    const nearestName = isCN
      ? (r.nearest?.store_name_cn || r.nearest?.store_name_en || '')
      : (r.nearest?.store_name_en || r.nearest?.store_name_cn || '');
    // Stash names + open the modal; resolve() is invoked when the user
    // taps one of the two buttons (see resolveFallback* below).
    this._fallbackResolve = null;
    this.setData({
      nearestStoreName: nearestName,
      fallbackStoreName: fallbackName,
      showFallbackModal: true,
    });
    return new Promise(resolve => { this._fallbackResolve = resolve; });
  },

  resolveFallbackContinue() {
    this.setData({ showFallbackModal: false });
    if (this._fallbackResolve) { this._fallbackResolve(true); this._fallbackResolve = null; }
  },
  resolveFallbackCancel() {
    this.setData({ showFallbackModal: false });
    if (this._fallbackResolve) { this._fallbackResolve(false); this._fallbackResolve = null; }
  },
  // Swallow the tap on the inner card so it doesn't dismiss-via-backdrop.
  noop() {},

  async placeOrder() {
    if (this.data.placing) return;
    const a = this.data.address;
    if (!a.recipient_name || !a.phone || !a.address) {
      wx.showToast({ title: this.data.lang === 'cn' ? '请填写完整地址' : 'Please fill in the address', icon: 'none' });
      return;
    }
    if (!this.data.deliverySlotId) {
      wx.showToast({ title: this.data.lang === 'cn' ? '请选择配送时间' : 'Please pick a delivery time', icon: 'none' });
      return;
    }
    // Up-front confirmation if the latest quote said nearest is short. The
    // /orders endpoint will also refuse on its own as a safety net, so this
    // is purely for UX — get the question out of the way before payment.
    if (this.data.needsFallback && !this.data.acceptedFallback) {
      const ok = await this.askFallbackConfirmation();
      if (!ok) return;
      this.setData({ acceptedFallback: true });
    }
    this.setData({ placing: true });

    try {
      // 1. Save address if it's new (id is null)
      let addressId = a.id;
      if (!addressId) {
        const saved = await api.post('/api/retail/addresses', {
          recipient_name: a.recipient_name,
          phone: a.phone,
          address: a.address,
          detail: a.detail || null,
          city: a.city || null,
          district: a.district || null,
          is_default: true,
        });
        addressId = saved?.id || saved?.data?.id;
      }
      if (!addressId) throw new Error(this.data.lang === 'cn' ? '地址保存失败' : 'Could not save address');

      // 2. Create order
      const state = cart.get();
      const orderItems = state.items.map(it => ({
        product_id: it.product_id,
        qty: it.qty,
        choices: (it.options || []).map(o => o.choice_id).filter(Boolean),
      }));
      const orderPayload = {
        items: orderItems,
        address_id: addressId,
        payment_method: this.data.paymentMethod,
        delivery_mode: this.data.deliveryMethod,
        delivery_slot_id: this.data.deliverySlotId,
        delivery_slot_label: this.data.deliverySlotLabel,
        voucher_code: this.data.voucherCode || null,
        customer_note: this.data.note || null,
        needs_cutlery: this.data.needsCutlery,
        needs_invoice: this.data.needsInvoice,
        accept_fallback: !!this.data.acceptedFallback,
      };
      let order;
      try {
        order = await api.post('/api/retail/orders', orderPayload);
      } catch (e) {
        // Server-side safety net: stock changed between quote and submit,
        // and the nearest store is now short. Show the same modal using
        // the fresh `nearest` + `fallback` info from the error body, and
        // retry once on confirmation.
        if (e?.message === 'needs_fallback_confirmation' && e.body) {
          const ok = await this.askFallbackConfirmation(e.body);
          if (!ok) { this.setData({ placing: false }); return; }
          this.setData({ acceptedFallback: true });
          orderPayload.accept_fallback = true;
          order = await api.post('/api/retail/orders', orderPayload);
        } else {
          throw e;
        }
      }
      const orderId = order?.id || order?.data?.id;
      if (!orderId) throw new Error(this.data.lang === 'cn' ? '订单创建失败' : 'Could not create order');

      // 3. Initiate payment
      const pay = await api.post('/api/retail/payment/create', { order_id: orderId });
      const payData = pay?.data || pay;

      if (payData?.dev || payData?.status === 'paid') {
        // DEV mode: auto-paid. Clear cart, prompt for push notifications
        // (one-shot consent for order-status updates), route to success.
        cart.clear();
        try { await notify.requestOrderStatusSubscription(orderId); } catch {}
        wx.redirectTo({ url: '/pages/order-success/order-success?id=' + orderId });
        return;
      }

      // PROD mode: real WeChat Pay JSAPI params would come back here.
      if (this.data.paymentMethod === 'wechat' && payData?.timeStamp) {
        wx.requestPayment({
          timeStamp: payData.timeStamp,
          nonceStr:  payData.nonceStr,
          package:   payData.package,
          signType:  payData.signType,
          paySign:   payData.paySign,
          success: async () => {
            cart.clear();
            try { await notify.requestOrderStatusSubscription(orderId); } catch {}
            wx.redirectTo({ url: '/pages/order-success/order-success?id=' + orderId });
          },
          fail: () => {
            wx.showToast({ title: this.data.lang === 'cn' ? '支付未完成' : 'Payment incomplete', icon: 'none' });
            this.setData({ placing: false });
          },
        });
        return;
      }

      // Alipay flow (TODO when alipay creds in place)
      wx.showToast({ title: 'Payment flow TBD', icon: 'none' });
      this.setData({ placing: false });
    } catch (e) {
      console.error('[checkout] place order failed:', e);
      const friendly = {
        insufficient_points: this.data.lang === 'cn' ? '积分不足' : 'Not enough points',
        insufficient_stock:  this.data.lang === 'cn' ? '库存不足' : 'Out of stock',
        no_zone_match:       this.data.lang === 'cn' ? '该地址无法配送' : 'Address not in delivery range',
      };
      wx.showToast({
        title: friendly[e.message] || ((this.data.lang === 'cn' ? '出错：' : 'Error: ') + e.message),
        icon: 'none',
        duration: 2400,
      });
      // If points came up short, re-quote so the UI updates with the gap.
      if (e.message === 'insufficient_points') this.refreshQuote();
      this.setData({ placing: false });
    }
  },
});
