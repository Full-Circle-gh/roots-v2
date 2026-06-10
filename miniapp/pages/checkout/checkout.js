// Checkout — collects address + delivery + payment method, places order,
// initiates payment. In DEV mode the payment auto-succeeds and we route
// straight to /pages/order-success. In PROD mode (real WeChat Pay):
// wx.requestPayment is invoked with the server-returned params.

const api    = require('../../utils/api');
const cart   = require('../../utils/cart');
const config = require('../../utils/config');
const lang   = require('../../utils/lang');
const notify = require('../../utils/notifications');
const zones  = require('../../utils/zones');

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
    localOnlyBlock: false,   // true when the cart has a Guangzhou-only item but the address is outside GZ
    localOnlyNames: [],      // display names of those offending items (for the banner + modal)
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
    // Fulfillment — 'delivery' (default) or 'pickup' (collect at a store).
    // The Delivery/Pickup toggle only renders when at least one store opted
    // in (pickupStores non-empty); otherwise checkout stays delivery-only.
    fulfillment: 'delivery',
    pickupStores: [],            // [{id, code, name_en, name_cn, address, city, district, phone}]
    pickupWindow: { open: '10:00', close: '20:00' },
    pickupPackingFee: 0,         // flat per-order packing fee for pickup (¥)
    pickupStoreId: null,
    pickupName: '',
    pickupPhone: '',
    pickupDate: '',              // 'YYYY-MM-DD'
    pickupTime: '',              // 'HH:MM'
    pickupDateLabel: '',         // pretty label for the picked date
    pickupMinDate: '',
    pickupMaxDate: '',
    paymentMethod: 'wechat',     // 'wechat' | 'alipay'  (points is no longer a method; see usePoints toggle below)
    pointsBalance: 0,            // customer's available points (drives Points option visibility)
    pointsValue: '0.00',         // ¥ value of the balance (display only)
    pointsRequired: 0,           // points needed to pay this order entirely
    pointsAffordable: false,     // balance covers requirement — gates the Points radio
    pointsRedeemRate: 100,       // points per ¥1 (from server config)
    pointsMaxUsable: 0,          // capped at min(balance, pointsRequiredFor(grossTotal))
    pointsToUse: 0,              // points the customer chose to apply (partial stack)
    pointsDiscount: '0.00',      // ¥ off the bill from pointsToUse (only meaningful when usePoints=true)
    pointsPotentialDiscount: '0.00', // ¥ off the bill IF usePoints were on — used in the toggle subtitle BEFORE the customer flips it
    usePoints: false,            // toggle: apply max usable on this order
    // Delivery scheduling — populated by the /quote response.
    scheduling: null,            // full scheduling object from server (slots, surcharge, hours)
    batchNotice: null,           // { ship_date, delivery_date, kind, kicker/title/message_en/cn, items[] } when a batch-made item ships rather than instant-delivers
    batchNoticeItems: [],         // [{ id, name, image }] — the fresh items, matched to the cart for thumbnails
    batchNoticePopup: false,      // true → the "Made fresh for you" modal is open
    batchNoticeSeen: false,       // popup auto-shows once per checkout visit; banner persists after
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
    routing: null,               // full routing block from /quote — { gate, nearest, fallback, missing_items, ... }
    fallbackGate: 'none',        // 'none' | 'simple_confirm' | 'options_5' — drives which modal opens
    needsFallback: false,        // gate !== 'none'
    fallbackStoreName: '',       // display name of the farther store (localized)
    nearestStoreName: '',        // display name of the (out-of-stock) nearest store (localized)
    fallbackExtraKm: null,       // km the fallback adds vs nearest (for option 3 messaging)
    fallbackExtraMin: null,      // estimated extra minutes
    missingItems: [],            // [{ product_id, name_en, name_cn, qty, available, image_data }]
    acceptedFallback: false,     // user clicked "Yes, ship from farther store" — sent as accept_fallback:true on /orders
    showFallbackModal: false,    // toggles the in-page 5-option modal
    fallbackBusy: false,         // disables buttons while a sub-fetch is in flight
    // Slot-conflict warning when the customer picks Wait-for-restock on a
    // HARD time slot (right_away / today HH:MM). Modal is brand-styled
    // (matches fb-modal-card) instead of wx.showModal which renders as the
    // native Android-grey alert — wrong palette, wrong typography. State
    // is mirrored by the askWaitForRestockConfirm() Promise.
    showWaitConfirmModal: false,
    waitConfirmSlotLabel: '',    // the slot the customer is about to lose
    // Substitute picker sub-screen
    showReplacePicker: false,    // overlay on top of the modal
    replacePickerIndex: 0,       // index into missingItems we're picking for
    substituteOptions: [],       // curated substitutes for current missing item
    chosenReplacements: [],      // [{ original_product_id, substitute_product_id, qty, name_en }]
    // Free-browse mode: when the curated list isn't what the customer
    // wants (or when there are no curated suggestions at all), they can
    // tap "Browse all products" and pick literally anything from the
    // catalogue via a search box. Backed by /api/retail/products?q=…
    browseAll: false,            // true = browse mode; false = curated mode
    browseQuery: '',             // current search text
    browseResults: [],           // products returned by the last /products fetch
    browseLoading: false,        // in-flight indicator for the search
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
      province: '',
      city: '',
      district: '',
    },
    // Delivery-area selector. Splits by language:
    //  • CN → WeChat's native region picker (province/city/district, always
    //    current/complete, Chinese labels).
    //  • EN → a bilingual 省→市→区 cascade (multiSelector) built from
    //    utils/zones.provinceTree + /api/retail/districts, mirroring the native
    //    wheel. Both write canonical Chinese province/city/district onto
    //    `address`, which is what the zone matcher needs.
    areaLabel: '',        // localized summary shown on the trigger ("Guangzhou · Tianhe")
    regionValue: [],      // CN native picker position [省, 市, 区]
    cityOptions: [],      // EN: [{ label, name_cn, name_en }] — for syncAreaLabel city→EN lookup
    cityLabel: '',        // EN: selected city label (label-build helper)
    // EN cascade picker (multiSelector): three label columns + index, plus the
    // canonical tree + the district column's source rows (for the confirm read).
    areaTree: { provCn: [], provLabel: [], citiesByProv: {} },
    areaArray: [[], [], []],   // [provinceLabels, cityLabels, districtLabels]
    areaIndex: [0, 0, 0],      // [provinceIdx, cityIdx, districtIdx]
    areaDistData: [],          // district rows backing column 3: [{label,name_cn,name_en}]
    areaDistCity: '',          // the city name_cn areaDistData belongs to (race guard)
    note: '',
    needsCutlery: false,
    needsInvoice: false,
    invoiceType: 'personal',   // 'personal' | 'company' (fapiao 发票)
    invoiceTitle: '',
    invoiceTaxId: '',
    invoiceEmail: '',
    placing: false,
    // True when the customer has bound their WeChat profile (nickname is the
    // gate field — set when /pages/profile/profile saves). Unbound customers
    // see an empty-state CTA instead of the manual address form, and the
    // place-order button routes them into the bind flow.
    isBound: true,
    lang: 'en',
    copy: {
      kicker: 'CHECKOUT',
      title: 'Where & how.',
      // Receipt-style section labels (kicker-styled, uppercase)
      orderSummary: 'YOUR ORDER',
      // Bear Serif section titles (match design's "Deliver to" / "How fast" / "Pay with")
      shipToTitle: 'Deliver to',
      pickupAtTitle: 'Pick up at',
      deliveryTab: 'Delivery',
      pickupTab: 'Pickup',
      pickupStoreLabel: 'Choose a store',
      pickupTimeTitle: 'Pickup time',
      pickupDatePh: 'Pick a date',
      pickupTimePh: 'Pick a time',
      pickupHoursHint: 'Pickup hours',
      pickupContactName: 'Who is collecting',
      pickupContactPhone: 'Contact phone',
      viewOnMap: 'View on map',
      howFastTitle: 'How fast',
      payWithTitle: 'Pay with',
      addOnsTitle: 'Add-ons',
      couponsTitle: 'Coupons',
      placeOrder: 'PLACE ORDER →',
      placeOrderBind: 'BIND WECHAT TO CONTINUE →',
      pay: 'PAY',
      name: 'Name',
      phone: 'Phone',
      addr: 'Address',
      detailPlaceholder: 'Floor / unit / apartment (optional)',
      cutlery: 'Include cutlery',
      invoice: 'Need an invoice',
      invPersonal: 'Personal',
      invCompany: 'Company',
      invTitlePh: 'Invoice title (your name or company)',
      invTaxIdPh: 'Company tax ID 统一社会信用代码',
      invEmailPh: 'Email to receive the e-invoice',
      noteLabel: 'Note for the kitchen (optional)',
      standardOpt: 'Standard',
      sameDayOpt: 'Same-day',
      maxOpt: 'MAX',
      regionPlaceholder: 'Tap to choose your delivery area',
      regionRequired: 'Please choose your delivery area',
      wechatOpt: 'WeChat Pay',
      alipayOpt: 'Alipay',
      pointsOpt: 'Points',
      free: 'FREE',
      // Bind-WeChat empty state, shown in place of the address form when
      // customer.nickname is unset. Tapping the CTA opens /pages/profile.
      bindTitle: 'Bind WeChat to ship to your door',
      bindBody: "We pull your name, phone and address straight from WeChat — accurate every time, no manual typing.",
      bindCta: 'Bind WeChat →',
      shipFromHint: 'From your WeChat profile · edit anytime in your address book',
    },
  },

  async onLoad() {
    const app = getApp();
    // Hard reset transient flags on every land. If a previous in-page action
    // left `placing` true (cancelled WeChat Pay sheet that didn't fire its
    // callback, hot-reload that preserved data, page brought back from cache),
    // the Place Order button renders as a disabled-looking gray slab with
    // "…" text — looks broken. Forcing them false here means a fresh land
    // is always interactive, no matter how the previous session ended.
    this.setData({
      lang: app.globalData.lang,
      placing: false,
      fallbackBusy: false,
      quoting: false,
    });
    this.applyLangCopy();

    // Load the delivery-area options up front — BEFORE the empty-cart bail and
    // the bind gate below — so the area picker is never blank in any transient
    // state (e.g. landing on checkout with an empty cart, during the 800ms
    // redirect window). Fire-and-forget: loadAreaOptions re-syncs the label
    // when it resolves, so it needn't block the rest of onLoad.
    this.loadAreaOptions();

    const state = cart.get();
    if (!state.items.length) {
      wx.showToast({ title: this.data.lang === 'cn' ? '购物车空空如也' : 'Your cart is empty', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/cart/cart' }), 800);
      return;
    }

    // Profile-binding gate. The order flow needs a WeChat-verified name +
    // phone + address — without it, every order would carry hand-typed data
    // with no link back to the customer's WeChat identity. Cart.js prompts
    // before navigating here, but checkout is reachable via deep-links so we
    // re-check on land and render an in-page empty state instead of
    // redirecting (the redirect ate the back stack and felt like a wall).
    // The CTA, and the place-order button, both route to /pages/profile.
    //
    // Wait for onLaunch's silentLogin to settle before reading customer.
    // Without this the deep-link arrives mid-auth, customer is null, and
    // the page renders the bind-empty state even for a bound customer —
    // visible as "I have to click Me first before checkout sees me".
    if (app.authReady) {
      try { await app.authReady; } catch {}
    }
    const cust = app.globalData.customer || {};
    const isBound = !!cust.nickname;
    this.setData({ isBound });

    // Stash the kitchen address for the "we don't deliver here" message.
    try {
      const cfg = await config.load();
      this.setData({ kitchenAddress: cfg?.delivery?.kitchenAddress || '' });
    } catch {}

    // Unbound customer — skip the address/quote/coupon loads. They'll run
    // in onShow once the customer comes back from the bind page.
    if (!isBound) return;

    // The area-picker options were already kicked off above (pre empty-cart bail).
    await this.loadAddressesAndQuote();
    this.loadPublicCoupons();
    this.loadPointsBalance();
    this.loadPickupStores();

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

  // Re-check bind state on every show so returning from /pages/profile
  // (after a successful bind via wx.navigateBack) flips the page from
  // empty-state to the real checkout without a manual refresh.
  async onShow() {
    const app = getApp();
    const cust = app.globalData.customer || {};
    const isBound = !!cust.nickname;
    const boundChanged = isBound !== this.data.isBound;
    const patch = {};
    if (boundChanged) patch.isBound = isBound;
    // Defensive: any time the page comes back to the foreground, clear the
    // "placing" / "fallbackBusy" flags. They're meant to debounce concurrent
    // taps inside one session — but if a wx.requestPayment or sub-modal
    // navigation didn't fire its completion callback (e.g. user swiped away
    // the WeChat Pay sheet), the flag stays true and the Place Order button
    // renders as `…` over a disabled black rectangle — looks "missing" to
    // the customer. Resetting on onShow is safe: any real in-flight order
    // POST that's actually still pending will set the flag back to true
    // before its next render.
    if (this.data.placing)      patch.placing = false;
    if (this.data.fallbackBusy) patch.fallbackBusy = false;
    if (Object.keys(patch).length) this.setData(patch);
    if (!isBound) return;
    // Always re-fetch saved addresses on onShow — coming back from the
    // /addresses page after editing a recipient name / address text must
    // surface the new value here (and on the picker dropdown). Previously
    // we bailed early when bind status hadn't changed, which is what made
    // the renamed recipient look like it never saved.
    //
    // To avoid stomping a half-typed inline new-address form, only the
    // initial first show (onLoad already loaded once) also re-runs the
    // coupons + points fetches — the rest only refresh the addresses list
    // and keep the current picked address selected when still present.
    if (boundChanged) {
      await this.loadAreaOptions();
      await this.loadAddressesAndQuote();
      this.loadPublicCoupons();
      this.loadPointsBalance();
      this.loadPickupStores();
    } else {
      this.reloadSavedAddresses();
    }
  },

  // Fetch the served-zone list and build the localized area-selector options.
  // Cheap + cached in utils/zones; safe to call on every bound land. After the
  // options exist, re-derive the trigger label for whatever address is current.
  async loadAreaOptions() {
    try {
      const list = await zones.loadZones();
      this.setData({ cityOptions: zones.cityOptions(list, this.data.lang) });
      if (this.data.lang !== 'cn') this.buildAreaPicker(list);
      this.syncAreaLabel();
    } catch (e) {
      console.warn('[checkout] loadAreaOptions failed:', e && e.message);
    }
  },

  // Re-derive the trigger label (and CN picker position) from the current
  // address. Used after any path that sets `address` (default load, picking a
  // saved address, returning from /addresses). In EN we localize the city to
  // English when it's a known catalogue city; the district stays as stored.
  syncAreaLabel() {
    const a = this.data.address || {};
    let cityLabel = a.city || '';
    if (this.data.lang !== 'cn') {
      const m = (this.data.cityOptions || []).find(o => o.name_cn === a.city);
      if (m) cityLabel = m.name_en;
    }
    const patch = {
      cityLabel,
      areaLabel: [cityLabel, a.district].filter(Boolean).join(' · '),
    };
    if (this.data.lang === 'cn' && a.province) {
      patch.regionValue = [a.province, a.city, a.district].filter(Boolean);
    }
    this.setData(patch);
  },

  // CN — WeChat native region picker. value = [省, 市, 区] (Chinese). For the
  // direct-administered municipalities the city column can come back as 市辖区;
  // fold that onto the province so the zone matcher sees a real city.
  onRegionChange(e) {
    const v = e.detail.value || [];
    let [province, city, district] = v;
    if (city === '市辖区' || city === '县') city = province;
    this.setData({
      regionValue: v,
      areaLabel: v.filter(Boolean).join(' · '),
      'address.province': province || '',
      'address.city': city || '',
      'address.district': district || '',
    });
    this.refreshQuote();
  },

  // EN — initialize the 省→市→区 cascade columns from the served-zone tree.
  // Defaults to province 0 / city 0 and warms that city's district column.
  buildAreaPicker(list) {
    const tree = zones.provinceTree(list, this.data.lang);
    if (!tree.provCn.length) return;
    const cities = tree.citiesByProv[tree.provCn[0]] || [];
    this.setData({
      areaTree: tree,
      areaArray: [tree.provLabel.slice(), cities.map(c => c.label), [this._distNoneLabel()]],
      areaIndex: [0, 0, 0],
      areaDistData: [this._distNone()],
      areaDistCity: '',
    });
    this._loadDistCol(cities[0]);
  },

  _distNoneLabel() { return this.data.lang === 'cn' ? '全城' : 'City-wide'; },
  _distNone() { return { label: this._distNoneLabel(), name_cn: '', name_en: 'City-wide' }; },

  // Load a city's districts into column 3 (with a leading "City-wide" sentinel
  // for districtless / whole-city picks). Cached per city in utils/zones.
  async _loadDistCol(city) {
    const cn = this.data.lang === 'cn';
    let rows = [this._distNone()];
    if (city) {
      try {
        const raw = await zones.loadDistricts(city.name_cn);
        rows = rows.concat((raw || []).map(d => ({
          label: cn ? d.name_cn : d.name_en, name_cn: d.name_cn, name_en: d.name_en,
        })));
      } catch (e) { console.warn('[checkout] loadDistricts failed:', e && e.message); }
    }
    const arr = (this.data.areaArray || [[], [], []]).slice();
    arr[2] = rows.map(r => r.label);
    this.setData({ areaArray: arr, areaDistData: rows, areaDistCity: city ? city.name_cn : '' });
  },

  // EN — a wheel column moved. Province change repopulates the city column +
  // reloads districts for its first city; city change reloads districts.
  async onAreaColumn(e) {
    const { column, value } = e.detail;
    const tree = this.data.areaTree;
    const idx = (this.data.areaIndex || [0, 0, 0]).slice();
    if (column === 0) {
      idx[0] = value; idx[1] = 0; idx[2] = 0;
      const cities = tree.citiesByProv[tree.provCn[value]] || [];
      const arr = this.data.areaArray.slice();
      arr[1] = cities.map(c => c.label);
      arr[2] = [this._distNoneLabel()];
      this.setData({ areaArray: arr, areaIndex: idx });
      await this._loadDistCol(cities[0]);
    } else if (column === 1) {
      idx[1] = value; idx[2] = 0;
      this.setData({ areaIndex: idx });
      const cities = tree.citiesByProv[tree.provCn[idx[0]]] || [];
      await this._loadDistCol(cities[value]);
    } else {
      idx[2] = value;
      this.setData({ areaIndex: idx });
    }
  },

  // EN — cascade confirmed. We know the province here, so set it directly
  // (better than leaving it blank for the server to backfill). District 0 is
  // the "City-wide" sentinel → blank district (city-wide delivery).
  async onAreaConfirm(e) {
    const v = e.detail.value || [];
    const pi = v[0] || 0, ci = v[1] || 0, di = v[2] || 0;
    const tree = this.data.areaTree;
    const provCn = tree.provCn[pi];
    const cities = tree.citiesByProv[provCn] || [];
    const c = cities[ci] || cities[0];
    if (!c) return;
    let dists = this.data.areaDistData;
    if (this.data.areaDistCity !== c.name_cn) {     // fast-confirm race guard
      const cn = this.data.lang === 'cn';
      let rows = [this._distNone()];
      try {
        const raw = await zones.loadDistricts(c.name_cn);
        rows = rows.concat((raw || []).map(d => ({
          label: cn ? d.name_cn : d.name_en, name_cn: d.name_cn, name_en: d.name_en,
        })));
      } catch (_) {}
      dists = rows;
    }
    const d = dists[di] || dists[0];
    const districtCn = (d && d.name_cn) || '';
    const provLabel = tree.provLabel[pi];
    const parts = (provLabel === c.label ? [c.label] : [provLabel, c.label])
      .concat(districtCn ? [d.label] : []);
    this.setData({
      areaIndex: [pi, ci, di],
      cityLabel: c.label,
      areaLabel: parts.join(' · '),
      'address.province': provCn,
      'address.city': c.name_cn,
      'address.district': districtCn,
    });
    this.refreshQuote();
  },

  // Lightweight re-fetch used by onShow when the user navigates back from
  // /pages/addresses. Refreshes `savedAddresses` and, if the currently
  // picked address still exists, mirrors its updated fields into the
  // `address` form so the displayed recipient_name / phone / etc. reflect
  // what was just edited. Doesn't re-run /quote because the address ID
  // didn't change.
  async reloadSavedAddresses() {
    try {
      const addrs = await api.get('/api/retail/addresses');
      const list  = Array.isArray(addrs) ? addrs : addrs?.data || [];
      const patch = { savedAddresses: list };
      // /pages/addresses sets `_addressJustPicked` on us before navigating
      // back when the customer taps a card to switch addresses. That ID wins
      // over the previously-picked one so the new pick takes effect without
      // forcing the customer to also tap CHANGE on this page.
      const justPicked = this.data._addressJustPicked;
      const targetId = justPicked || this.data.address?.id;
      let next = targetId ? list.find(a => a.id === targetId) : null;
      if (!next && list.length) next = list.find(a => a.is_default) || list[0];

      if (next) {
        const switched = next.id !== this.data.address?.id;
        patch.address = {
          id: next.id,
          recipient_name: next.recipient_name || '',
          phone: next.phone || '',
          address: next.address || '',
          detail: next.detail || '',
          province: next.province || '',
          city: next.city || '',
          district: next.district || '',
        };
        // Clear the cross-page flag so onShow doesn't keep re-applying it.
        if (justPicked) patch._addressJustPicked = null;
        try { getApp().globalData.activeAddressId = next.id; } catch {}
        this.setData(patch);
        this.syncAreaLabel();
        // If the actual selected address changed, re-run /quote so the
        // zone-match, delivery fee, and packing fee all reflect the new
        // city/district instead of the previous one.
        if (switched) this.refreshQuote();
        return;
      }
      this.setData(patch);
    } catch {}
  },

  // Routes the customer into the WeChat-profile bind flow. After they save
  // there, wx.navigateBack returns to this page and onShow refreshes state.
  bindWechat() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  // Loads saved addresses, picks the default (or first), and runs the first
  // /quote. Extracted from onLoad so onShow can re-run it after the customer
  // binds via the profile page.
  async loadAddressesAndQuote() {
    try {
      const addrs = await api.get('/api/retail/addresses');
      const list = Array.isArray(addrs) ? addrs : addrs?.data || [];
      const def = list.find(a => a.is_default) || list[0] || null;
      this.setData({
        savedAddresses: list,
        showNewForm: list.length === 0,
      });
      if (def) {
        try { getApp().globalData.activeAddressId = def.id; } catch {}
        this.setData({
          address: {
            id: def.id,
            recipient_name: def.recipient_name || '',
            phone: def.phone || '',
            address: def.address || '',
            detail: def.detail || '',
            province: def.province || '',
            city: def.city || '',
            district: def.district || '',
          },
        });
        this.syncAreaLabel();
      }
    } catch {}
    this.refreshQuote();
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

  // Load the stores that opted into pickup + the global pickup window. When
  // none exist, the Delivery/Pickup toggle stays hidden and checkout runs
  // delivery-only. Prefills the contact fields from the customer's default
  // address so most customers don't retype their name/phone.
  async loadPickupStores() {
    try {
      const r = await api.get('/api/retail/pickup-stores');
      const data = r?.data || r || {};
      const stores = Array.isArray(data.stores) ? data.stores : [];
      const win = data.window || { open: '10:00', close: '20:00' };
      const patch = {
        pickupStores: stores,
        pickupWindow: win,
        pickupPackingFee: Number(data.packing_fee) || 0,
      };
      // Date bounds: today → +30 days (matches the server's far-future guard).
      const pad = n => String(n).padStart(2, '0');
      const now = new Date();
      const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      patch.pickupMinDate = fmt(now);
      patch.pickupMaxDate = fmt(new Date(now.getTime() + 30 * 86400000));
      // Prefill contact from the current address (WeChat-bound profile).
      const a = this.data.address || {};
      if (!this.data.pickupName)  patch.pickupName  = a.recipient_name || '';
      if (!this.data.pickupPhone) patch.pickupPhone = a.phone || '';
      // Default the store to the only one when there's a single pickup store.
      if (stores.length === 1 && !this.data.pickupStoreId) patch.pickupStoreId = stores[0].id;
      this.setData(patch);
      this.applyDefaultPickupSlot();
    } catch (e) {
      console.warn('[checkout] loadPickupStores failed:', e && e.message);
    }
  },

  // Pick a sensible default pickup date+time: the next 30-min increment that
  // falls inside the window today, else the window's open time tomorrow.
  applyDefaultPickupSlot() {
    if (this.data.pickupDate && this.data.pickupTime) return;
    const win = this.data.pickupWindow || { open: '10:00', close: '20:00' };
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const [oh, om] = String(win.open  || '10:00').split(':').map(Number);
    const [ch, cm] = String(win.close || '20:00').split(':').map(Number);
    const openMins = oh * 60 + om, closeMins = ch * 60 + cm;
    const nowMins = now.getHours() * 60 + now.getMinutes();
    let date = fmtDate(now);
    let startMins = Math.max(openMins, Math.ceil((nowMins + 15) / 30) * 30);
    if (startMins > closeMins) {            // too late today → tomorrow at open
      date = fmtDate(new Date(now.getTime() + 86400000));
      startMins = openMins;
    }
    const time = `${pad(Math.floor(startMins / 60))}:${pad(startMins % 60)}`;
    this.setData({
      pickupDate: date,
      pickupTime: time,
      pickupDateLabel: this.fmtPickupDateLabel(date),
    });
  },

  fmtPickupDateLabel(ymd) {
    if (!ymd) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const isToday = dt.getTime() === today.getTime();
    if (this.data.lang === 'cn') return isToday ? '今天' : `${m}月${d}日`;
    if (isToday) return 'Today';
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  },

  // Delivery ⇄ Pickup toggle. Re-derives totals through refreshQuote, which
  // short-circuits to the local pickup math when fulfillment === 'pickup'.
  setFulfillment(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.fulfillment) return;
    this.setData({ fulfillment: mode });
    if (mode === 'pickup') this.applyDefaultPickupSlot();
    this.refreshQuote();
  },

  selectPickupStore(e) {
    this.setData({ pickupStoreId: Number(e.currentTarget.dataset.id) });
  },
  openStoreMap(e) {
    const id = Number(e.currentTarget.dataset.id);
    const store = (this.data.pickupStores || []).find(s => s.id === id);
    if (!store || store.lat == null || store.lng == null) return;
    const cn = this.data.lang === 'cn';
    wx.openLocation({
      latitude: Number(store.lat),
      longitude: Number(store.lng),
      name: cn ? (store.name_cn || store.name_en) : (store.name_en || store.name_cn),
      address: [store.city, store.district, store.address].filter(Boolean).join(' · '),
      scale: 16
    });
  },
  onPickupName(e)  { this.setData({ pickupName: e.detail.value }); },
  onPickupPhone(e) { this.setData({ pickupPhone: e.detail.value }); },
  onPickupDateChange(e) {
    const date = e.detail.value;
    this.setData({ pickupDate: date, pickupDateLabel: this.fmtPickupDateLabel(date) });
  },
  onPickupTimeChange(e) {
    this.setData({ pickupTime: e.detail.value });
  },

  // Local total math for pickup — no zone, no delivery/packing fee. Mirrors
  // the server (fees forced to 0 for pickup). Points stay a preview here;
  // the /orders POST clamps them authoritatively.
  recomputePickupTotals() {
    const state = cart.get();
    const subtotal = cart.subtotal();
    const L = this.data.lang;
    let flashSavings = 0;
    const items = state.items.map(it => {
      const onFlash = !!it.is_flash && it.regular_price != null && Number(it.regular_price) > Number(it.unit_price);
      const lineSave = onFlash ? (Number(it.regular_price) - Number(it.unit_price)) * it.qty : 0;
      if (lineSave > 0) flashSavings += lineSave;
      return {
        ...it,
        display_name: lang.pick(it.name_en, it.name_cn, L),
        line_total: '¥' + (it.unit_price * it.qty).toFixed(2),
        on_flash: onFlash,
        was_total: onFlash ? '¥' + (Number(it.regular_price) * it.qty).toFixed(2) : '',
        save_text: onFlash ? (L === 'cn' ? '省 ¥' : 'save ¥') + lineSave.toFixed(2) : '',
      };
    });
    const itemCount = state.items.reduce((s, it) => s + (it.qty || 0), 0);
    const voucherDiscount = Number(this.data.voucherDiscount) || 0;
    const packingFee = Number(this.data.pickupPackingFee) || 0;
    const grossTotal = Math.max(0, subtotal + packingFee - voucherDiscount);
    const rate = Number(this.data.pointsRedeemRate) || 100;
    let pointsToUse = 0, pointsDiscount = 0;
    if (this.data.usePoints && this.data.pointsBalance > 0) {
      pointsToUse = Math.min(this.data.pointsBalance, Math.ceil(grossTotal * rate));
      pointsDiscount = pointsToUse / rate;
    }
    const pointsAffordable = grossTotal > 0 && pointsDiscount >= grossTotal;
    const total = Math.max(0, grossTotal - pointsDiscount);
    const savedTotal = flashSavings + voucherDiscount + pointsDiscount;
    this.setData({
      items, itemCount,
      subtotal: subtotal.toFixed(2),
      zone: null, zoneError: '',
      deliveryFee: '0.00', packingFee: packingFee.toFixed(2), freeShipping: false,
      needsFallback: false, fallbackGate: 'none',
      pointsToUse,
      pointsDiscount: pointsDiscount.toFixed(2),
      pointsAffordable,
      savedTotal: savedTotal > 0 ? savedTotal.toFixed(2) : '',
      total: total.toFixed(2),
      quoting: false,
    });
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
        pickupAtTitle: '到店自提',
        deliveryTab: '配送',
        pickupTab: '自提',
        pickupStoreLabel: '选择门店',
        pickupTimeTitle: '取货时间',
        pickupDatePh: '选择日期',
        pickupTimePh: '选择时间',
        pickupHoursHint: '自提时间',
        pickupContactName: '取货人',
        pickupContactPhone: '联系电话',
        viewOnMap: '查看地图',
        howFastTitle: '配送方式',
        payWithTitle: '支付方式',
        addOnsTitle: '附加',
        couponsTitle: '优惠券',
        placeOrder: '提交订单 →',
        placeOrderBind: '绑定微信 继续 →',
        pay: '应付',
        name: '收件人',
        phone: '电话',
        addr: '地址',
        detailPlaceholder: '楼层 / 单元 / 公寓 (可选)',
        cutlery: '需要餐具',
        invoice: '需要发票',
        invPersonal: '个人',
        invCompany: '企业',
        invTitlePh: '发票抬头 (姓名或公司名称)',
        invTaxIdPh: '企业税号 统一社会信用代码',
        invEmailPh: '接收电子发票的邮箱',
        noteLabel: '给厨房的备注 (可选)',
        standardOpt: '标准配送',
        sameDayOpt: '当日达',
        maxOpt: '极速达',
        regionPlaceholder: '点击选择配送区域',
        regionRequired: '请选择配送区域',
        wechatOpt: '微信支付',
        alipayOpt: '支付宝',
        pointsOpt: '积分抵扣',
        free: '免费',
        bindTitle: '绑定微信,配送到家',
        bindBody: '我们从微信直接读取您的姓名、电话和地址 — 准确无误,无需手动输入。',
        bindCta: '绑定微信 →',
        shipFromHint: '来自您的微信资料 · 可在地址簿中随时修改',
      },
    });
  },

  // Recomputes the displayed totals. Always renders the items + subtotal
  // immediately (so the UI doesn't blink to empty), then fires off a server
  // quote in the background and patches the fee fields when it lands. The
  // server is the source of truth for the zone-driven delivery + packing fees.
  refreshQuote() {
    // Pickup has no zone/fee quote — compute totals locally and bail. Every
    // trigger that calls refreshQuote (voucher apply, points toggle, payment
    // change) routes here while in pickup mode.
    if (this.data.fulfillment === 'pickup') {
      this.recomputePickupTotals();
      return;
    }
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

    // When the "Use points" toggle is on, send the full balance and let
    // the server clamp to min(balance, pts-needed). The quote response
    // tells us what was actually applied + the cash discount.
    // payment_method always sends the picked radio — server treats the
    // residual (or 0) as a charge against that rail.
    const usingPoints = !!this.data.usePoints;
    const body = {
      items: orderItems,
      delivery_mode: this.data.deliveryMethod,
      payment_method: this.data.paymentMethod,
      points_to_use:  usingPoints ? (this.data.pointsBalance || 0) : 0,
      // CRITICAL: include the picked slot so /quote's analyzeShortage uses
      // the same `requiresStockGate` decision /orders POST will use. Without
      // this, /quote sees slot=null → skips stock gate → reports gate=none,
      // but /orders sees slot=right_away → triggers stock gate → returns
      // needs_fallback_confirmation. The disagreement made the 5-option
      // modal silently invisible (client thought no fallback was needed,
      // so the pre-check on placeOrder didn't open it) and the submit
      // retry loop hung until the watchdog tripped.
      delivery_slot_id: this.data.deliverySlotId || null,
      // Lets the server tell express (asap → soonest batch) apart from a
      // schedule-for-later pick (recompute the fresh notice to the chosen
      // date). Express also carries a future slot_id, so the date alone
      // can't disambiguate.
      slot_kind: this.data.selectedSlotKind || '',
    };
    if (hasSaved) body.address_id = a.id;
    else          body.address    = { city: a.city, district: a.district };

    this.setData({ quoting: true });
    // Returning the chain so callers (e.g. the stock-race recovery in
    // submitOrder) can `await this.refreshQuote()` before inspecting
    // this.data.needsFallback / fallbackGate.
    return api.post('/api/retail/checkout/quote', body)
      .then(resp => {
        const data = resp?.data || resp || {};
        // A successful quote means the address can receive this cart — clear any
        // prior "Guangzhou only" block.
        if (this.data.localOnlyBlock) this.setData({ localOnlyBlock: false, localOnlyNames: [] });
        // The endpoint returns { success: false, error: 'no_zone_match', data } when
        // no zone matches. api.js may surface that as a thrown error OR as a
        // resolved value depending on the helper — defensively handle both.
        // Re-price the cart from the server's authoritative line breakdown so
        // the displayed line prices + subtotal reflect the CURRENT flash state
        // (a sale may have started/ended while items sat in the cart). The
        // /orders endpoint already charges this; this keeps the display honest.
        if (Array.isArray(data.lines)) cart.reprice(data.lines);
        const srvSubtotal = Number(data.subtotal != null ? data.subtotal : cart.subtotal());
        // Per-line flash treatment (strikethrough original + "save ¥X" tag)
        // and tally the flash savings for the "You saved" line below.
        let flashSavings = 0;
        const itemRows = cart.get().items.map(it => {
          const onFlash = !!it.is_flash && it.regular_price != null && Number(it.regular_price) > Number(it.unit_price);
          const lineSave = onFlash ? (Number(it.regular_price) - Number(it.unit_price)) * it.qty : 0;
          if (lineSave > 0) flashSavings += lineSave;
          return {
            ...it,
            display_name: lang.pick(it.name_en, it.name_cn, L),
            line_total: '¥' + (it.unit_price * it.qty).toFixed(2),
            on_flash: onFlash,
            was_total: onFlash ? '¥' + (Number(it.regular_price) * it.qty).toFixed(2) : '',
            save_text: onFlash ? (L === 'cn' ? '省 ¥' : 'save ¥') + lineSave.toFixed(2) : '',
          };
        });
        this.setData({ items: itemRows, subtotal: srvSubtotal.toFixed(2) });
        const deliveryFee = Number(data.delivery_fee) || 0;
        const packingFee  = Number(data.packing_fee)  || 0;
        let effectiveDelivery = deliveryFee;
        if (this.data.voucherFreeShip) effectiveDelivery = 0;
        const voucherDiscount = Number(this.data.voucherDiscount) || 0;
        const grossTotal = Math.max(0, srvSubtotal + effectiveDelivery + packingFee - voucherDiscount);
        const payingWithPoints = !!this.data.usePoints && data.points_affordable;
        // Partial-points stack: server clamped points_to_use → applied amount + discount.
        const pointsMaxUsable    = Number(data.points_max_usable) || 0;
        const pointsToUseApplied = Number(data.points_to_use_applied) || 0;
        const pointsDiscount     = Number(data.points_discount) || 0;
        const total = payingWithPoints ? 0 : Math.max(0, grossTotal - pointsDiscount);
        // Group slots by date for the UI. Server returns a flat list; we
        // bucket by date_iso so the wxml can render a "day → slots" tree.
        const sch = data.scheduling || null;
        const slotsByDay = this.buildSlotGroups(sch);
        // Reconcile the previously-picked slot. If the saved slotId is no
        // longer in the fresh list (zone changed, day rolled over, etc.),
        // clear it so the customer is forced to pick again.
        const validSlotIds = new Set(['right_away', ...((sch?.slots || []).map(s => s.slot_id))]);
        // A "schedule for later" pick is a bare YYYY-MM-DD inside the open
        // calendar window — it is NOT enumerated in sch.slots (those are only
        // today/tomorrow's time-slots), so validSlotIds would never contain it.
        // Without this, re-quoting after the customer picks a future date
        // clears deliverySlotId and the pick silently vanishes. Treat it as
        // still-valid when the kind is 'schedule' and it falls inside [min,max].
        const _schWin = sch?.schedule || null;
        const _curId  = this.data.deliverySlotId;
        const _isScheduledPick = this.data.selectedSlotKind === 'schedule'
          && !!_curId && /^\d{4}-\d{2}-\d{2}$/.test(_curId)
          && !!_schWin && _curId >= _schWin.min_date && _curId <= _schWin.max_date;
        const stillValid = !!_curId && (validSlotIds.has(_curId) || _isScheduledPick);
        let nextSlotId    = stillValid ? this.data.deliverySlotId    : '';
        let nextSlotLabel = stillValid ? this.data.deliverySlotLabel : '';
        let nextSlotSurcharge = stillValid ? this.data.deliverySurcharge : 0;
        // Default to "Right away" when the kitchen is open and the
        // customer hasn't picked something else. Customer can switch to
        // a later time-slot or scheduled day if they prefer.
        if (!stillValid && sch?.right_away_available) {
          nextSlotId = 'right_away';
          nextSlotLabel = this.data.lang === 'cn' ? '立即配送' : 'Right away';
          nextSlotSurcharge = 0;
        }
        const totalWithSurcharge = Math.max(0, (Number(total) || 0) + nextSlotSurcharge);
        // Routing info — drives both the simple yes/no fallback modal
        // (legacy) and the new 5-option modal (GZ + non-excluded district
        // + right_away slot). Server tells us which via `routing.gate`.
        const routing = data.routing || null;
        const fallbackGate = routing?.gate || 'none';
        const needsFallback = fallbackGate !== 'none' && !routing?.ok;
        const isCN = this.data.lang === 'cn';
        const fallbackStoreName = needsFallback && routing?.fallback
          ? (isCN ? (routing.fallback.store_name_cn || routing.fallback.store_name_en || '')
                  : (routing.fallback.store_name_en || routing.fallback.store_name_cn || ''))
          : '';
        const nearestStoreName = needsFallback && routing?.nearest
          ? (isCN ? (routing.nearest.store_name_cn || routing.nearest.store_name_en || '')
                  : (routing.nearest.store_name_en || routing.nearest.store_name_cn || ''))
          : '';
        const keepAccepted = this.data.acceptedFallback && needsFallback
          && this.data.routing?.fallback?.store_id === routing?.fallback?.store_id;
        const fallbackExtraKm  = routing?.fallback?.extra_km ?? null;
        const fallbackExtraMin = routing?.fallback?.extra_min_estimate ?? null;
        const missingItems     = Array.isArray(routing?.missing_items) ? routing.missing_items : [];
        // "You saved" total — flash savings + voucher + points + waived
        // delivery (free-ship voucher). Empty string hides the summary row.
        const savedTotal = flashSavings + voucherDiscount + pointsDiscount
          + (this.data.voucherFreeShip ? deliveryFee : 0);
        this.setData({
          zone: data.zone || null,
          zoneError: '',
          deliveryFee: effectiveDelivery.toFixed(2),
          savedTotal: savedTotal > 0 ? savedTotal.toFixed(2) : '',
          packingFee:  packingFee.toFixed(2),
          freeShipping: !!data.free_shipping,
          pointsEarnedPreview: Number(data.points_earned_preview) || 0,
          pointsRequired:    Number(data.points_required) || 0,
          pointsAffordable:  !!data.points_affordable,
          pointsRedeemRate:  Number(data.points_redeem_rate) || 100,
          pointsBalance:     Number(data.points_balance) || this.data.pointsBalance || 0,
          pointsMaxUsable,
          pointsToUse:       pointsToUseApplied,
          pointsDiscount:    pointsDiscount.toFixed(2),
          // What the points WOULD be worth if the toggle were on, even
          // when it isn't right now. Used as the "potential savings" copy
          // in the Use-points toggle subtitle so the customer sees their
          // points have value before flipping the switch.
          pointsPotentialDiscount: (pointsMaxUsable / (Number(data.points_redeem_rate) || 100)).toFixed(2),
          scheduling: sch,
          batchNotice: data.batch_notice || null,
          batchNoticeItems: this.buildBatchNoticeItems(data.batch_notice),
          slotsByDay,
          deliverySlotId: nextSlotId,
          deliverySlotLabel: nextSlotLabel,
          deliverySurcharge: nextSlotSurcharge,
          total: totalWithSurcharge.toFixed(2),
          quoting: false,
          routing,
          fallbackGate,
          needsFallback,
          fallbackStoreName,
          nearestStoreName,
          fallbackExtraKm,
          fallbackExtraMin,
          missingItems,
          acceptedFallback: keepAccepted,
        });
        // First time a fresh-batch notice appears for this checkout visit,
        // pop the modal once so it can't be missed. The inline banner stays
        // put afterwards as a persistent reminder, and re-quotes (slot
        // changes) only refresh the banner — they don't re-pop.
        if (data.batch_notice && !this.data.batchNoticeSeen) {
          this.setData({ batchNoticePopup: true, batchNoticeSeen: true });
        }
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
        if (code === 'local_only_outside_gz') {
          // Cart has a Guangzhou-only item but the address is outside GZ — the
          // order can't ship. Block + name the offending items so the customer
          // knows exactly what to remove (or switch to a GZ address).
          const L = this.data.lang;
          const names = ((err.body && err.body.data && err.body.data.products) || [])
            .map(p => lang.pick(p.name_en, p.name_cn, L))
            .filter(Boolean);
          this.setData({
            zone: null,
            zoneError: '',
            localOnlyBlock: true,
            localOnlyNames: names,
            deliveryFee: '0.00',
            packingFee: '0.00',
            freeShipping: false,
            total: subtotal.toFixed(2),
            quoting: false,
          });
        } else if (code === 'no_zone_match' || code === 'max_not_offered') {
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
    // Bail only when we have NOTHING to render — no slots AND no schedule
    // window. An older server (pre-2026-05-20) could return an empty `slots`
    // array for day-only city zones with no Today chip; in that case we
    // synthesise the Express slot from schedule.min_date locally so the
    // radio still has a label and a working tap target.
    if (!sch || sch.mode !== 'day_only') {
      this.setData({ hasTodayOption: false, scheduleMinDate: '', scheduleMaxDate: '', expressLabel: '', expressSub: '' });
      return;
    }
    let slots = Array.isArray(sch.slots) ? sch.slots : [];
    if (!slots.length && sch.schedule?.min_date) {
      slots = [{
        slot_id:    sch.schedule.min_date,
        date_iso:   sch.schedule.min_date,
        is_same_day: false,
        is_day_only: true,
        requires_surcharge: false,
        surcharge:  0,
        label_en:   `Earliest ${sch.schedule.min_date}`,
        label_cn:   `最早 ${sch.schedule.min_date}`,
      }];
    }
    if (!slots.length) {
      this.setData({ hasTodayOption: false, scheduleMinDate: '', scheduleMaxDate: '', expressLabel: '', expressSub: '' });
      return;
    }
    const surcharge = Number(sch.same_day_surcharge) || 0;
    const todaySlot   = slots.find(s => s.is_same_day);
    // Express default = the server's authoritative express_slot (earliest day,
    // no surcharge), with a prettified date label. Fall back to any
    // non-surcharged enumerated slot, then to the first slot — but NEVER let
    // the surcharged Today chip become the Express default (that silently
    // added the same-day surcharge to Express).
    const expressSlot = this.prettyExpressSlot()
      || slots.find(s => !s.requires_surcharge)
      || slots[0];
    const hasTodayOption = !!todaySlot && surcharge > 0;
    const L = this.data.lang;

    // Express label: customer-facing copy is always "1–2 days" for day-only
    // zones — SF Express transit time to non-GZ cities is 1–2 business days
    // regardless of the admin-side min_lead_days buffer (which we use for
    // scheduling, not for what we promise the buyer). One label, both
    // shapes, no conditional copy.
    const expressLabel = L === 'cn' ? '加急配送(1-2 天)' : 'Express delivery (1–2 days)';
    const expressSub   = L === 'cn' ? '系统将为您安排最早的可用日期' : 'we ship on the earliest available day';

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

  // The server's authoritative express_slot with a prettified bilingual date
  // label ("Wed, Jun 11" / "6月11日"), matching the style used for the other
  // day picks. Returns null when the server didn't supply an express_slot
  // (older server) so callers can fall back. Never carries a surcharge.
  prettyExpressSlot() {
    const es = this.data.scheduling?.express_slot;
    if (!es || !es.date_iso) return null;
    const [y, m, d] = es.date_iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return {
      ...es,
      label_en: dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      label_cn: `${m}月${d}日`,
    };
  },

  // Tap "Express delivery" — uses the server's authoritative express_slot
  // (the zone's true earliest day at no surcharge). Falls back to a synthesized
  // schedule.min_date slot for older servers that don't return express_slot.
  // Either way it must NEVER carry the Today chip's same-day surcharge.
  pickExpress() {
    const sch = this.data.scheduling || {};
    const es = this.prettyExpressSlot();
    if (es) {
      this.applyDayOnlySlot(es, 'express');
      return;
    }
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
    const pointsDiscount  = Number(this.data.pointsDiscount)  || 0;
    const payingWithPoints = !!this.data.usePoints && this.data.pointsAffordable;
    const gross = Math.max(0, subtotal + deliveryFee + packingFee - voucherDiscount + surcharge);
    const total = payingWithPoints ? 0 : Math.max(0, gross - pointsDiscount);
    // Re-quote on a change of slot identity OR of slot KIND. The kind matters
    // even when the id is unchanged: when the kitchen is open the server only
    // emits the surcharged "today" chip, so Express defaults onto that very
    // chip — Express and "Get it today" then share one slot_id. Without the
    // kind check, switching between them wouldn't re-quote, so the server never
    // learns slot_kind flipped and the "Made fresh for you" notice (suppressed
    // for same-day "today" picks) would stay stale on screen.
    const slotChanged = slot.slot_id !== this.data.deliverySlotId
                     || kind !== this.data.selectedSlotKind;
    this.setData({
      selectedSlotKind: kind,
      deliverySlotId: slot.slot_id,
      deliverySlotLabel: label,
      deliverySurcharge: surcharge,
      total: total.toFixed(2),
    });
    // Re-quote when the slot identity/kind changes — slot affects server-side
    // stock-gating + fallback detection (right_away triggers stock check,
    // scheduled-for-later bypasses it) AND the fresh-batch notice. Without this
    // re-quote, the client can think `needsFallback=false` while /orders POST
    // returns `needs_fallback_confirmation` for the same cart, leading to the
    // submit-retry loop we just patched.
    if (slotChanged) this.refreshQuote();
  },

  // Customer picked a slot chip. Updates the slot id + label + surcharge,
  // recomputes total locally, AND re-runs /quote — because the slot's
  // same-day-ness changes server-side stock-gating + fallback detection.
  // The original "no server round-trip needed, fees don't change" comment
  // missed this: right_away/today triggers stock check + may need fallback;
  // a future-dated slot bypasses it. Without the re-quote the client
  // thinks `needsFallback=false` while /orders POST returns
  // `needs_fallback_confirmation`, hanging the submit flow.
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
    const pointsDiscount  = Number(this.data.pointsDiscount)  || 0;
    const payingWithPoints = !!this.data.usePoints && this.data.pointsAffordable;
    const gross = Math.max(0, subtotal + deliveryFee + packingFee - voucherDiscount + surcharge);
    const total = payingWithPoints ? 0 : Math.max(0, gross - pointsDiscount);
    const slotChanged = id !== this.data.deliverySlotId;
    // Mutually-exclusive radio state: the Schedule-for-later option keys
    // its filled "on" state off `selectedSlotKind === 'schedule'` (set by
    // applyDayOnlySlot). pickSlot used to only touch deliverySlotId, so
    // after the customer scheduled a date and then tapped Right away (or
    // a 16-18pm chip), the Schedule dot stayed filled — two radios showed
    // as selected at the same time. Resetting selectedSlotKind here makes
    // the time-slot picker the single source of truth: any slot picked
    // through `pickSlot` is by definition NOT a scheduled-for-later pick,
    // so Schedule's dot turns off.
    this.setData({
      deliverySlotId: id,
      deliverySlotLabel: label,
      deliverySurcharge: surcharge,
      selectedSlotKind: '',
      total: total.toFixed(2),
    });
    if (slotChanged) this.refreshQuote();
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

  // Build the display list of freshly-made items for the popup: the server
  // tells us WHICH cart products are batch-made (id + names); we match each to
  // the live cart row to pull its thumbnail + the customer's chosen language
  // name. Returns [] when there's no notice.
  buildBatchNoticeItems(notice) {
    const items = (notice && Array.isArray(notice.items)) ? notice.items : [];
    if (!items.length) return [];
    const L = this.data.lang;
    const cartItems = cart.get().items || [];
    const imgById = {};
    for (const ci of cartItems) {
      if (ci.product_id != null && !imgById[ci.product_id]) imgById[ci.product_id] = ci.image || '';
    }
    return items.map(it => ({
      id: it.id,
      name: lang.pick(it.name_en, it.name_cn, L),
      image: imgById[it.id] || '',
    }));
  },

  // "Made fresh for you" modal — auto-opens once per visit, and the banner's
  // tap target re-opens it on demand. Closing leaves the inline banner.
  openBatchNotice() {
    if (this.data.batchNotice) this.setData({ batchNoticePopup: true });
  },
  closeBatchNotice() {
    this.setData({ batchNoticePopup: false });
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
        province: a.province || '',
        city: a.city || '',
        district: a.district || '',
      },
    });
    this.syncAreaLabel();
    this.refreshQuote();
  },
  showAddNew() {
    // Clear the form so the user picks a fresh area + types the street.
    this.setData({
      showNewForm: true,
      pickerOpen: false,
      address: { id: null, recipient_name: '', phone: '', address: '', detail: '', province: '', city: '', district: '' },
      areaLabel: '',
      regionValue: [],
      cityLabel: '',
      areaIndex: [0, 0, 0],
    }, () => this.scrollToAddrForm());
    this.refreshQuote();
  },
  // The "use a new address" link lives at the bottom of a long saved-address
  // list, so when the list collapses into the (shorter) inline form the user
  // is left scrolled past it. Pull the address section back up under the
  // header so the empty form is the first thing in view.
  scrollToAddrForm() {
    wx.createSelectorQuery().in(this)
      .select('#addr-section').boundingClientRect()
      .selectViewport().scrollOffset()
      .exec((res) => {
        const rect = res && res[0];
        const vp = res && res[1];
        if (!rect || !vp) return;
        wx.pageScrollTo({ scrollTop: vp.scrollTop + rect.top - 16, duration: 250 });
      });
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
          address: def.address, detail: def.detail || '', province: def.province || '',
          city: def.city || '', district: def.district || '',
        },
      });
      this.syncAreaLabel();
      this.refreshQuote();
    }
  },
  onNoteChange(e)    { this.setData({ note: e.detail.value }); },
  onCutleryToggle(e) { this.setData({ needsCutlery: e.detail.value }); },
  onInvoiceToggle(e) { this.setData({ needsInvoice: e.detail.value }); },
  onInvoiceType(e)   { this.setData({ invoiceType: e.currentTarget.dataset.type }); },
  onInvoiceTitle(e)  { this.setData({ invoiceTitle: e.detail.value }); },
  onInvoiceTaxId(e)  { this.setData({ invoiceTaxId: e.detail.value }); },
  onInvoiceEmail(e)  { this.setData({ invoiceEmail: e.detail.value }); },
  setDelivery(e) {
    this.setData({ deliveryMethod: e.currentTarget.dataset.method });
    this.refreshQuote();
  },
  // Pay-method radio. Points is NO LONGER one of these — it lives as a
  // toggle above the radios. Migrating any pre-existing 'points' value
  // (from a session predating the split) is handled in onLoad.
  setPayment(e) {
    const m = e.currentTarget.dataset.method;
    if (m === this.data.paymentMethod) return;
    this.setData({ paymentMethod: m });
    this.refreshQuote();
  },

  // Toggle: "Use my points". Flips usePoints, which becomes the trigger
  // for the partial-stack server path (points_to_use = balance). When
  // pointsAffordable is true on the resulting quote, the total drops to
  // 0 and the picked radio is skipped at /payment/create.
  onTogglePoints(e) {
    const on = !!e.detail.value;
    if (on === this.data.usePoints) return;
    this.setData({ usePoints: on });
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
    // Stale-flag self-heal: a real submitOrder() takes at most a few seconds
    // round-trip. If `placing` has been true for >5s, it's almost certainly
    // stuck from a prior session (cancelled pay sheet that didn't fire its
    // callback, network drop, hot-reload). Treat a tap in that state as a
    // recovery action — reset the flag and proceed with a fresh attempt
    // instead of bailing and looking dead.
    if (this.data.placing) {
      const stuckMs = Date.now() - (this._placingStartedAt || 0);
      if (stuckMs > 5000) {
        console.warn('[checkout] tap on stale placing flag — recovering');
        this.setData({ placing: false });
        // Fall through and proceed.
      } else {
        return;
      }
    }
    // Bind-on-action also gates pickup — checkout needs a WeChat identity.
    if (!this.data.isBound) {
      this.bindWechat();
      return;
    }
    // Pickup branch — no address/zone/slot/fallback machinery. Validate the
    // store + contact + time, then submit straight away.
    if (this.data.fulfillment === 'pickup') {
      const cn = this.data.lang === 'cn';
      if (!this.data.pickupStoreId) {
        wx.showToast({ title: cn ? '请选择自提门店' : 'Please choose a pickup store', icon: 'none' });
        return;
      }
      if (!(this.data.pickupName || '').trim() || !(this.data.pickupPhone || '').trim()) {
        wx.showToast({ title: cn ? '请填写取货人和电话' : 'Enter the collector name and phone', icon: 'none' });
        return;
      }
      if (!this.data.pickupDate || !this.data.pickupTime) {
        wx.showToast({ title: cn ? '请选择取货时间' : 'Please pick a pickup time', icon: 'none' });
        return;
      }
      return this.submitOrder({});
    }
    // Replaces the native <button disabled> guard now that the place-order
    // tap target is a <view>. Tapping while in a disabled state silently
    // no-ops (with a toast when the customer would benefit from knowing
    // why).
    if (this.data.isBound && this.data.zoneError) {
      wx.showToast({
        title: this.data.lang === 'cn' ? '此地址暂不在配送范围内' : "We don't deliver to this address",
        icon: 'none',
      });
      return;
    }
    // Guangzhou-only item in a cart bound outside GZ — can't ship. Spell out
    // which items so the customer can remove them or switch to a GZ address.
    if (this.data.isBound && this.data.localOnlyBlock) {
      this.showLocalOnlyModal();
      return;
    }
    // Bind-on-action: if the customer hit Place Order without binding their
    // WeChat profile (deep-linked past cart's gate), route them to bind
    // first. onShow will resume the checkout flow on their return.
    if (!this.data.isBound) {
      this.bindWechat();
      return;
    }
    const a = this.data.address;
    if (!a.recipient_name || !a.phone || !a.address) {
      wx.showToast({ title: this.data.lang === 'cn' ? '请填写完整地址' : 'Please fill in the address', icon: 'none' });
      return;
    }
    // Delivery area must come from the selector — every picked zone sets a
    // city (GZ districts also set a district; non-GZ city zones don't need
    // one). Without it the matcher can't place the address, so surface a clear
    // "choose your area" toast instead of the confusing downstream "pick a
    // delivery time" error you'd otherwise hit (no zone → no slots).
    if (!a.city) {
      wx.showToast({ title: this.data.copy.regionRequired, icon: 'none' });
      return;
    }
    if (!this.data.deliverySlotId) {
      wx.showToast({ title: this.data.lang === 'cn' ? '请选择配送时间' : 'Please pick a delivery time', icon: 'none' });
      return;
    }
    // Out-of-stock flow at the nearest store. The server told us via the
    // latest /quote whether to use the rich 5-option modal or the simple
    // yes/no. The 5-option flow now owns _all_ the order-creation logic;
    // we route to it then return — it calls submitOrder() once the
    // customer picks an option.
    if (this.data.needsFallback && !this.data.acceptedFallback && !this.data.fallback_choice_applied) {
      if (this.data.fallbackGate === 'options_5') {
        this.setData({ showFallbackModal: true });
        return;
      }
      if (this.data.fallbackGate === 'simple_confirm') {
        const ok = await this.askFallbackConfirmation();
        if (!ok) return;
        this.setData({ acceptedFallback: true });
      }
    }
    return this.submitOrder({ accept_fallback: !!this.data.acceptedFallback });
  },

  // "Guangzhou only" explainer modal. `names` overrides the stored list (used
  // by the submit-time backstop when /orders rejects without a prior quote).
  showLocalOnlyModal(names) {
    const cn = this.data.lang === 'cn';
    const list = (names && names.length ? names : this.data.localOnlyNames) || [];
    const items = list.length ? (cn ? '：' + list.join('、') : ': ' + list.join(', ')) : '';
    wx.showModal({
      title: cn ? '仅广州可配送' : 'Guangzhou delivery only',
      content: cn
        ? `这些商品只支持广州同城配送${items},无法寄往广州以外。请移除这些商品,或切换到广州的收货地址。`
        : `These items only deliver within Guangzhou${items} — they can't ship outside the city. Please remove them, or switch to a Guangzhou address.`,
      showCancel: false,
      confirmText: cn ? '我知道了' : 'OK',
    });
  },

  // The actual order POST + payment flow. Extracted from placeOrder so the
  // 5-option modal handlers can call it directly with the right
  // fallback_choice / replacements payload.
  async submitOrder(extra) {
    const a = this.data.address;
    this.setData({ placing: true, showFallbackModal: false, showReplacePicker: false });
    this._placingStartedAt = Date.now();
    // Watchdog: every imaginable success/fail path below SHOULD reset
    // `placing` to false, but real-world bugs include (a) cancelled
    // wx.requestPayment that doesn't fire complete on certain WeChat
    // builds, (b) network hangs longer than the request timeout, (c)
    // hot-reload that preserves data across recompiles. If `placing`
    // stays true past 20s the button locks into its disabled "…" state
    // forever and the only escape is killing the mini-program. Force a
    // reset so the customer can always tap again.
    if (this._placingWatchdog) clearTimeout(this._placingWatchdog);
    this._placingWatchdog = setTimeout(() => {
      if (this.data.placing) {
        console.warn('[checkout] placing-flag watchdog tripped — force reset');
        this.setData({ placing: false });
      }
      this._placingWatchdog = null;
    }, 20000);

    const isPickup = this.data.fulfillment === 'pickup';
    try {
      // 1. Save address if it's new (id is null) — delivery only. Pickup
      // carries the store + contact instead of a delivery address.
      let addressId = a.id;
      if (!isPickup && !addressId) {
        const saved = await api.post('/api/retail/addresses', {
          recipient_name: a.recipient_name,
          phone: a.phone,
          address: a.address,
          detail: a.detail || null,
          province: a.province || null,
          city: a.city || null,
          district: a.district || null,
          is_default: true,
        });
        addressId = saved?.id || saved?.data?.id;
      }
      if (!isPickup && !addressId) throw new Error(this.data.lang === 'cn' ? '地址保存失败' : 'Could not save address');

      // 2. Create order
      const state = cart.get();
      const orderItems = state.items.map(it => ({
        product_id: it.product_id,
        qty: it.qty,
        choices: (it.options || []).map(o => o.choice_id).filter(Boolean),
      }));
      // Same translation as the quote: "Use points" toggle → send the
      // full balance as points_to_use; server clamps and writes the ledger.
      // payment_method is always the picked radio — when the discount
      // equals grossTotal, server sets order.total=0 and /payment/create
      // short-circuits to paid (the radio is just the fallback rail).
      // Fapiao — require what's needed to actually issue the e-invoice. Throws
      // route to the same catch as the address check (resets `placing`, toasts).
      if (this.data.needsInvoice) {
        const cn = this.data.lang === 'cn';
        if (!(this.data.invoiceTitle || '').trim()) throw new Error(cn ? '请填写发票抬头' : 'Enter the invoice title');
        if (this.data.invoiceType === 'company' && !(this.data.invoiceTaxId || '').trim()) throw new Error(cn ? '请填写企业税号' : 'Enter the company tax ID');
        if (!/^\S+@\S+\.\S+$/.test((this.data.invoiceEmail || '').trim())) throw new Error(cn ? '请填写有效的发票邮箱' : 'Enter a valid email for the e-invoice');
      }
      const usingPoints = !!this.data.usePoints;
      // Fields shared by both fulfillment paths.
      const common = {
        items: orderItems,
        payment_method: this.data.paymentMethod,
        voucher_code: this.data.voucherCode || null,
        customer_note: this.data.note || null,
        needs_cutlery: this.data.needsCutlery,
        needs_invoice: this.data.needsInvoice,
        invoice_type:   this.data.needsInvoice ? this.data.invoiceType : null,
        invoice_title:  this.data.needsInvoice ? (this.data.invoiceTitle || '').trim() : null,
        invoice_tax_id: this.data.needsInvoice && this.data.invoiceType === 'company' ? (this.data.invoiceTaxId || '').trim() : null,
        invoice_email:  this.data.needsInvoice ? (this.data.invoiceEmail || '').trim() : null,
        points_to_use:  usingPoints ? (this.data.pointsBalance || 0) : 0,
      };
      const orderPayload = isPickup
        ? {
            ...common,
            fulfillment_type: 'pickup',
            pickup_store_id: this.data.pickupStoreId,
            pickup_name:  (this.data.pickupName  || '').trim(),
            pickup_phone: (this.data.pickupPhone || '').trim(),
            // Local-naive datetime — server reads getHours() in its own (UTC+8)
            // clock, which matches the customer's, so no Z/offset is sent.
            pickup_time: `${this.data.pickupDate}T${this.data.pickupTime}:00`,
          }
        : {
            ...common,
            address_id: addressId,
            delivery_mode: this.data.deliveryMethod,
            delivery_slot_id: this.data.deliverySlotId,
            delivery_slot_label: this.data.deliverySlotLabel,
            delivery_slot_kind: this.data.selectedSlotKind || '',
            ...(extra || {}),
          };
      let order;
      try {
        console.log('[checkout] POST /api/retail/orders →', {
          slot_id: orderPayload.delivery_slot_id,
          item_count: orderPayload.items.length,
          address_id: orderPayload.address_id,
        });
        const t0 = Date.now();
        order = await api.post('/api/retail/orders', orderPayload);
        console.log('[checkout] POST /api/retail/orders ← OK in', Date.now() - t0, 'ms', { id: order?.id || order?.data?.id });
      } catch (e) {
        console.warn('[checkout] POST /api/retail/orders ← FAIL', { message: e?.message, status: e?.status, body: e?.body });
        // Stock-at-submit safety net. Server returned needs_fallback_confirmation
        // because we either didn't have a fallback_choice yet OR stock changed
        // between quote and submit. The 5-option modal owns this flow — its
        // wx:if requires `fallbackGate === 'options_5'` AND `missingItems[]`
        // populated, so calling askFallbackConfirmation() directly here used
        // to hang forever (it sets showFallbackModal=true but neither the
        // gate nor missingItems, so no modal renders). Cleanly hand off by
        // re-running /quote — that path correctly sets gate + missing_items
        // for the live cart state, and the modal opens via its normal
        // condition. We then bail with placing:false so the modal's own
        // submit handler picks up from here on the customer's choice.
        if (e?.message === 'needs_fallback_confirmation') {
          this.setData({ placing: false, acceptedFallback: false });
          try { await this.refreshQuote(); } catch {}
          if (this.data.needsFallback && this.data.fallbackGate === 'options_5') {
            this.setData({ showFallbackModal: true });
          } else if (this.data.needsFallback && this.data.fallbackGate === 'simple_confirm') {
            const ok = await this.askFallbackConfirmation();
            if (!ok) return;
            this.setData({ acceptedFallback: true });
            return this.submitOrder({ accept_fallback: true });
          } else if (!extra || !extra._stockRetried) {
            // Quote and /orders disagree. /quote says no fallback needed,
            // /orders says it does. Retry once with the same payload (in
            // case the server-side race already resolved). The
            // `_stockRetried` flag below guarantees we never spin forever
            // — without it the disagreement would loop as fast as the
            // network can churn (button visibly flickers).
            return this.submitOrder({ ...(extra || {}), _stockRetried: true });
          } else {
            // Already retried once and still inconsistent — server has a
            // bug or stock dropped to 0 while we were typing. Stop the
            // loop, tell the customer plainly, and surface the items the
            // server thinks are missing so they can decide what to do.
            console.error('[checkout] /quote ↔ /orders inconsistency on fallback gate; aborting retry loop', e?.body);
            const isCN = this.data.lang === 'cn';
            const nearestName = isCN
              ? (e?.body?.nearest?.store_name_cn || e?.body?.nearest?.store_name_en || '')
              : (e?.body?.nearest?.store_name_en || e?.body?.nearest?.store_name_cn || '');
            wx.showModal({
              title: isCN ? '库存暂时不足' : 'Temporarily out of stock',
              content: isCN
                ? `${nearestName || '最近门店'}缺货,请稍后再试或修改购物车。`
                : `${nearestName || 'The nearest store'} is short of stock — please try again later or update your cart.`,
              showCancel: false,
              confirmText: isCN ? '我知道了' : 'OK',
            });
          }
          return;
        }
        throw e;
      }
      const orderId = order?.id || order?.data?.id;
      if (!orderId) throw new Error(this.data.lang === 'cn' ? '订单创建失败' : 'Could not create order');

      // 3. Initiate payment
      console.log('[checkout] POST /api/retail/payment/create →', { order_id: orderId });
      const tPay = Date.now();
      const pay = await api.post('/api/retail/payment/create', { order_id: orderId });
      console.log('[checkout] POST /api/retail/payment/create ← OK in', Date.now() - tPay, 'ms');
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
          },
          // ALWAYS reset placing — some WeChat builds don't fire `fail`
          // when the customer dismisses the pay sheet by tapping outside,
          // leaving the button stuck in the "..." disabled state forever.
          // `complete` runs on success AND on dismiss, so we're covered.
          complete: () => {
            this.setData({ placing: false });
          },
        });
        return;
      }

      // Alipay flow: the server returned a precreate QR (PNG data URL). Hand
      // off to the dedicated page, which renders it, lets the customer save +
      // scan it from Alipay, and polls /payment/status until the async notify
      // (or trade.query fallback) flips the order to paid. Stash payData so
      // the page skips a second precreate round-trip. Cart is cleared by that
      // page once paid — don't clear here (customer may still back out).
      if (this.data.paymentMethod === 'alipay' && payData?.qr_png) {
        try { wx.setStorageSync('alipayPay:' + orderId, payData); } catch {}
        this.setData({ placing: false });
        wx.redirectTo({ url: '/pages/alipay-pay/alipay-pay?id=' + orderId });
        return;
      }

      // Unknown rail / missing pay params — fail loudly rather than silently.
      console.error('[checkout] no payment handler for', this.data.paymentMethod, payData);
      wx.showToast({ title: this.data.lang === 'cn' ? '支付方式暂不可用' : 'Payment unavailable', icon: 'none' });
      this.setData({ placing: false });
    } catch (e) {
      console.error('[checkout] place order failed:', e);
      // Race-on-pay: stock changed between quote and Pay tap. Re-fetch the
      // quote and react automatically — the old behaviour just toasted and
      // left the customer to figure out what to do next (the warning banner
      // is below the fold on most screens). Now:
      //   • If the refreshed quote reveals a fallback gate → open the
      //     5-option (or simple-confirm) modal immediately so they pick.
      //   • If the race already resolved (no shortage on re-quote) →
      //     auto-retry the order once. Capped at one retry to avoid loops.
      //   • Otherwise → toast with a clear "remove this item or try later"
      //     hint so the customer doesn't think the page is dead.
      if (e?.message === 'insufficient_stock' || e?.message === 'no_shortage') {
        wx.showToast({
          title: this.data.lang === 'cn' ? '库存已变化,正在刷新…' : 'Stock changed — refreshing…',
          icon: 'none',
          duration: 1500,
        });
        this.setData({ placing: false, acceptedFallback: false });
        try { await this.refreshQuote(); } catch {}
        // 1. Quote now shows a fallback gate → open the modal automatically.
        const gate = this.data.fallbackGate;
        if (this.data.needsFallback && gate === 'options_5') {
          this.setData({ showFallbackModal: true });
          return;
        }
        if (this.data.needsFallback && gate === 'simple_confirm') {
          const ok = await this.askFallbackConfirmation();
          if (!ok) return;
          this.setData({ acceptedFallback: true });
          return this.submitOrder({ accept_fallback: true, _stockRetried: true });
        }
        // 2. No gate AND we haven't auto-retried yet → race already
        // resolved server-side, just resubmit the same payload.
        if (!extra || !extra._stockRetried) {
          return this.submitOrder({ ...(extra || {}), _stockRetried: true });
        }
        // 3. Still failing after a retry — give the customer a clear next step.
        const offendingId = e?.body?.product_id;
        const offending = offendingId
          ? (this.data.items || []).find(it => it.product_id === offendingId)
          : null;
        const name = offending ? (this.data.lang === 'cn' ? offending.name_cn : offending.name_en) : '';
        wx.showToast({
          title: name
            ? (this.data.lang === 'cn' ? `「${name}」库存不足` : `${name} is out of stock`)
            : (this.data.lang === 'cn' ? '部分商品库存不足,请稍后重试或修改购物车' : 'Some items are out of stock — try again later or update your cart'),
          icon: 'none',
          duration: 2800,
        });
        return;
      }
      // Guangzhou-only backstop: if the order POST refuses (e.g. the quote was
      // skipped or stale), explain it with the same modal + remember the block.
      if (e?.message === 'local_only_outside_gz') {
        const L = this.data.lang;
        const names = ((e.body && e.body.products) || [])
          .map(p => lang.pick(p.name_en, p.name_cn, L))
          .filter(Boolean);
        this.setData({ placing: false, localOnlyBlock: true, localOnlyNames: names });
        this.showLocalOnlyModal(names);
        return;
      }
      const friendly = {
        insufficient_points: this.data.lang === 'cn' ? '积分不足' : 'Not enough points',
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

  // ───── 5-option fallback modal ────────────────────────────────────────
  // Dismiss without picking anything (taps backdrop or × button).
  closeFallbackModal() {
    this.setData({ showFallbackModal: false, showReplacePicker: false });
  },

  // Option 1 — cancel missing items, ship the rest from nearest.
  async fbCancelMissing() {
    if (this.data.fallbackBusy) return;
    this.setData({ fallbackBusy: true });
    try { await this.submitOrder({ fallback_choice: 'cancel_missing' }); }
    finally { this.setData({ fallbackBusy: false }); }
  },

  // Option 2 — replace missing items with substitutes. Opens the picker
  // sub-screen one item at a time. When all picked, submit the order.
  async fbReplaceMissing() {
    if (this.data.fallbackBusy) return;
    this.setData({ chosenReplacements: [], replacePickerIndex: 0 });
    await this._loadSubstitutesForCurrentMissing();
  },

  // Option 3 — full order from the farther store. Same as legacy accept_fallback.
  async fbFullFromFallback() {
    if (this.data.fallbackBusy) return;
    this.setData({ fallbackBusy: true, acceptedFallback: true });
    try { await this.submitOrder({ fallback_choice: 'full_from_fallback' }); }
    finally { this.setData({ fallbackBusy: false }); }
  },

  // Option 4 — wait for the nearest store to restock. Order pays now,
  // sits in 'awaiting_restock' until stock arrives at that store.
  //
  // Slot-conflict warning: "Wait for restock" means we ship whenever
  // stock arrives — could be hours, could be days. That conflicts with
  // a HARD time-slot pick (right_away / today HH:MM–HH:MM) because the
  // restock might not happen inside the chosen window. Only the hard
  // picks need a confirmation; flexible picks (day-only Express
  // "earliest available", Schedule-for-later date-only) already imply
  // "whenever, we trust you" and don't conflict.
  async fbWaitForRestock() {
    if (this.data.fallbackBusy) return;
    const slotId = this.data.deliverySlotId || '';
    const isHardSlot = slotId === 'right_away' || /T\d{2}:\d{2}/.test(slotId);
    if (isHardSlot) {
      const ok = await this.askWaitForRestockConfirm();
      if (!ok) return;
    }
    this.setData({ fallbackBusy: true });
    try { await this.submitOrder({ fallback_choice: 'wait_for_restock' }); }
    finally { this.setData({ fallbackBusy: false }); }
  },

  // Brand-styled "your hard time slot may not be honored" warning. Opens
  // an in-page modal (fb-modal-card) instead of wx.showModal so the
  // palette + typography match the rest of the checkout flow. Returns a
  // Promise<bool>: true = customer accepted, false = cancelled.
  askWaitForRestockConfirm() {
    this._waitConfirmResolve = null;
    // Remember whether the 5-option sheet was open and hide it while the
    // confirm modal is up — otherwise the sheet's z-index 9000 paints
    // over this 1000-level dialog and the customer sees nothing. We
    // restore it on cancel so they can pick a different option.
    this._fallbackWasOpen = !!this.data.showFallbackModal;
    this.setData({
      showFallbackModal: false,
      showWaitConfirmModal: true,
      waitConfirmSlotLabel: this.data.deliverySlotLabel || '',
    });
    return new Promise(resolve => { this._waitConfirmResolve = resolve; });
  },
  resolveWaitConfirmContinue() {
    this.setData({ showWaitConfirmModal: false });
    this._fallbackWasOpen = false;
    if (this._waitConfirmResolve) { this._waitConfirmResolve(true); this._waitConfirmResolve = null; }
  },
  resolveWaitConfirmCancel() {
    // Cancel = customer changed their mind; bounce them back to the
    // 5-option sheet so they can pick another path instead of being
    // dumped silently back onto the checkout page.
    this.setData({
      showWaitConfirmModal: false,
      showFallbackModal: this._fallbackWasOpen,
    });
    this._fallbackWasOpen = false;
    if (this._waitConfirmResolve) { this._waitConfirmResolve(false); this._waitConfirmResolve = null; }
  },

  // Option 5 — cancel the whole order. Just close the modal; nothing posts.
  fbCancelOrder() { this.closeFallbackModal(); },

  // ───── Substitute picker sub-screen ───────────────────────────────────
  async _loadSubstitutesForCurrentMissing() {
    const i = this.data.replacePickerIndex;
    const item = this.data.missingItems[i];
    if (!item) {
      // No more items to pick — submit the order with all replacements.
      const replacements = this.data.chosenReplacements.map(r => ({
        original_product_id: r.original_product_id,
        substitute_product_id: r.substitute_product_id,
        qty: r.qty,
      }));
      this.setData({ fallbackBusy: true });
      try { await this.submitOrder({ fallback_choice: 'replace_missing', replacements }); }
      finally { this.setData({ fallbackBusy: false }); }
      return;
    }
    const storeId = this.data.routing?.nearest?.store_id;
    if (!storeId) {
      wx.showToast({ title: this.data.lang === 'cn' ? '未找到门店' : 'No store', icon: 'none' });
      return;
    }
    try {
      const options = await api.get(`/api/retail/products/${item.product_id}/substitute-options?store_id=${storeId}`);
      const rawCurated = Array.isArray(options) ? options : (options.data || []);
      // Pre-format sell_price to a 2-decimal string so float artefacts
      // (e.g. 27.200000000000003) don't surface in the UI.
      const curated = rawCurated.map(s => ({
        ...s,
        sell_price: (Number(s.sell_price ?? s.price ?? 0)).toFixed(2),
      }));
      this.setData({
        substituteOptions: curated,
        // Reset browse state when opening the picker for a fresh item.
        // If there are NO curated suggestions, jump straight into browse
        // mode so the customer isn't stuck on an empty-state screen.
        browseAll: curated.length === 0,
        browseQuery: '',
        browseResults: [],
        showFallbackModal: false,
        showReplacePicker: true,
      });
      if (curated.length === 0) this._loadBrowseResults();
    } catch (e) {
      wx.showToast({ title: this.data.lang === 'cn' ? '加载失败' : 'Load failed', icon: 'none' });
      this.setData({ showReplacePicker: false });
    }
  },

  // Toggle between curated-substitutes view and free-browse view inside
  // the replace-picker overlay. Customers who don't see what they want in
  // the recommended list can hit "Browse all products" to pick anything.
  toggleBrowseAll() {
    const nextBrowse = !this.data.browseAll;
    this.setData({ browseAll: nextBrowse });
    if (nextBrowse && !this.data.browseResults.length) {
      this._loadBrowseResults();
    }
  },

  onBrowseQueryInput(e) {
    const q = e.detail.value || '';
    this.setData({ browseQuery: q });
    // Debounce: only fire after the customer pauses typing for 250ms.
    if (this._browseDebounce) clearTimeout(this._browseDebounce);
    this._browseDebounce = setTimeout(() => this._loadBrowseResults(), 250);
  },

  clearBrowseQuery() {
    this.setData({ browseQuery: '' });
    this._loadBrowseResults();
  },

  async _loadBrowseResults() {
    const q = (this.data.browseQuery || '').trim();
    // Exclude the missing product itself — it's "out of stock", picking
    // it back as a substitute would just re-trigger the same failure.
    const excludeId = this.data.missingItems[this.data.replacePickerIndex]?.product_id;
    this.setData({ browseLoading: true });
    try {
      const path = '/api/retail/products?limit=40' + (q ? '&q=' + encodeURIComponent(q) : '');
      const r = await api.get(path);
      const list = Array.isArray(r) ? r : (r.data || []);
      const filtered = list.filter(p => p.id !== excludeId);
      // Normalize shape to match curated substitute rows so the WXML
      // template can render either list with the same markup. Pre-format
      // sell_price to a 2-decimal string so floats like 27.200000000000003
      // (server-side calc artefact) don't leak into the UI.
      const normalized = filtered.map(p => ({
        product_id: p.id,
        name_en:    p.name_en,
        name_cn:    p.name_cn,
        sku:        p.sku,
        sell_price: (Number(p.price ?? p.sell_price ?? 0)).toFixed(2),
        image_data: p.image_data || p.image_url || '',
        curated:    false,
      }));
      this.setData({ browseResults: normalized, browseLoading: false });
    } catch (e) {
      console.warn('[checkout] browse-all fetch failed:', e.message);
      this.setData({ browseLoading: false });
    }
  },

  // User tapped a substitute in the picker. The picked product can live in
  // EITHER `substituteOptions` (curated) OR `browseResults` (free-browse) —
  // search both. Previously this only checked substituteOptions, so taps in
  // browse mode found nothing in the list and bailed silently.
  onPickSubstitute(e) {
    const subId = +e.currentTarget.dataset.id;
    const i = this.data.replacePickerIndex;
    const orig = this.data.missingItems[i];
    const sub = (this.data.substituteOptions || []).find(s => s.product_id === subId)
             || (this.data.browseResults    || []).find(s => s.product_id === subId);
    if (!sub || !orig) return;
    const chosen = [...this.data.chosenReplacements, {
      original_product_id: orig.product_id,
      substitute_product_id: sub.product_id,
      qty: orig.qty,
      name_en: sub.name_en,
      name_cn: sub.name_cn,
    }];
    this.setData({ chosenReplacements: chosen, replacePickerIndex: i + 1 });
    // Move on to the next missing item (or submit if we're done).
    this._loadSubstitutesForCurrentMissing();
  },

  // Back-button on the picker: go back one step or close.
  onReplacePickerBack() {
    const i = this.data.replacePickerIndex;
    if (i <= 0) {
      // Back to the modal.
      this.setData({ showReplacePicker: false, showFallbackModal: true });
      return;
    }
    // Drop last chosen, reload picker for previous index.
    const chosen = this.data.chosenReplacements.slice(0, -1);
    this.setData({ chosenReplacements: chosen, replacePickerIndex: i - 1 });
    this._loadSubstitutesForCurrentMissing();
  },
});
