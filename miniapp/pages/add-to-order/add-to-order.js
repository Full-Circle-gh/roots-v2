// "Forgot something?" — add items to an EXISTING order and pay only the
// price difference. A self-contained picker (kept off the shared shop/cart so
// the normal checkout flow stays untouched): browse the catalog, bump qty,
// and — for products with customer choices (dressing / paid extras) — pick
// options in a sheet. The server stages the lines and merges them into the
// order's open parcel once WeChat confirms the charge
// (POST /api/retail/orders/:id/addon/create → finalizeOrderAddon).

const api  = require('../../utils/api');
const lang = require('../../utils/lang');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return api.BASE + u;
  return u;
}

function effPrice(p) {
  const regular = Number(p.price ?? p.sell_price) || 0;
  const eff = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
  return eff;
}

function deltaText(d, cn) {
  const n = Number(d) || 0;
  if (!n) return '';
  return n > 0 ? '+¥' + n.toFixed(2) : '−¥' + Math.abs(n).toFixed(2);
}

Page({
  data: {
    orderId: null,
    orderNo: '',
    lang: 'en',
    loading: true,
    notEditable: false,        // order moved past the edit window
    query: '',
    products: [],              // [{ id, name, price, price_disp, image, stock, has_options, qty }]
    optionLines: [],           // [{ key, product_id, name, options_label, unit_price, unit_disp, qty, choices, line_disp }]
    addTotalDisp: '¥0.00',
    addCount: 0,
    submitting: false,
    // Option sheet
    opShow: false,
    opLoading: false,
    opProduct: null,           // { id, name, base_price }
    opGroups: [],              // [{ id, question, type, is_required, choices:[{id,label,delta_text,delta,sold_out,picked}] }]
    opQty: 1,
    opTotalDisp: '¥0.00',
    copy: {
      title: 'Add to your order',
      sub: 'Forgot something? Add it here and pay just the difference — it ships in the same parcel.',
      searchPh: 'Search products',
      payBtn: 'Pay',
      more: 'more',
      choose: 'Choose ›',
      yourAdds: 'With options',
      empty: 'No products found.',
      notEditable: 'This order has already shipped, so it can\'t be changed. Place a new order instead.',
      added: 'Added to your order ✓',
      payIncomplete: 'Payment incomplete',
      soldOut: 'Sold out',
      pickRequired: 'Please choose an option',
      opAdd: 'Add',
      opCancel: 'Cancel',
      back: '← Back',
      clear: 'clear',
    },
  },

  // Master catalog (all products, with live qty). The rendered `products`
  // list is a filtered view of this, so search filters instantly client-side
  // and qty survives across searches without a server round-trip.
  _all: [],

  async onLoad(query) {
    const app = getApp();
    const L = app.globalData.lang;
    this.setData({ orderId: parseInt(query.order_id, 10) || null, lang: L });
    this.applyLangCopy();
    await this.loadOrder();
    await this.loadProducts();
  },

  applyLangCopy() {
    if (this.data.lang !== 'cn') return;
    this.setData({
      copy: {
        title: '为订单加单',
        sub: '忘了买什么?在这里补上,只需补付差价 — 与原订单同一个包裹寄出。',
        searchPh: '搜索商品',
        payBtn: '支付',
        more: '加购',
        choose: '选择 ›',
        yourAdds: '已选选项',
        empty: '没有找到商品。',
        notEditable: '此订单已发货,无法修改。请重新下单。',
        added: '已加入订单 ✓',
        payIncomplete: '支付未完成',
        soldOut: '已售罄',
        pickRequired: '请选择一个选项',
        opAdd: '加入',
        opCancel: '取消',
        back: '← 返回',
        clear: '清除',
      },
    });
  },

  async loadOrder() {
    if (!this.data.orderId) { this.setData({ loading: false, notEditable: true }); return; }
    try {
      const o = await api.get('/api/retail/orders/' + this.data.orderId);
      const data = o?.data || o;
      // Mirror the server-side edit window: paid|preparing AND no parcel shipped.
      const shipped = (data.shipments || []).some(s => s.state === 'dispatched' || s.state === 'delivered');
      const refundPending = data.refund_status &&
        ['pending', 'reviewing', 'approved', 'paid'].includes(data.refund_status);
      const editable = ['paid', 'preparing'].includes(data.status) && !shipped && !refundPending;
      this.setData({ orderNo: data.order_no || '', notEditable: !editable });
    } catch (e) {
      this.setData({ notEditable: true });
    }
  },

  // Load the whole catalog ONCE, then filter client-side as the customer
  // types (instant, no per-keystroke server hit).
  async loadProducts() {
    this.setData({ loading: true });
    try {
      const resp = await api.get('/api/retail/products?limit=500&slim=1').catch(() => []);
      const raw = Array.isArray(resp) ? resp : (resp?.data || []);
      const L = this.data.lang;
      this._all = raw.map(p => {
        const price = effPrice(p);
        const nameEn = p.name_en || '';
        const nameCn = p.name_cn || '';
        return {
          id: p.id,
          name: lang.pick(nameEn, nameCn, L),
          _search: (nameEn + ' ' + nameCn).toLowerCase(),
          price,
          price_disp: '¥' + price.toFixed(2),
          image: absUrl(p.image_data || (`/api/retail/products/${p.id}/image`)),
          stock: Number(p.stock != null ? p.stock : (p.stock_qty != null ? p.stock_qty : 999)),
          has_options: !!p.has_options,
          qty: 0,
        };
      });
      this.setData({ loading: false });
      this.applyFilter();
    } catch (e) {
      this._all = [];
      this.setData({ products: [], loading: false });
    }
  },

  // Filter the master catalog by the current query and render the result.
  // qty lives on the master rows, so it persists as the search narrows/widens.
  applyFilter() {
    const s = (this.data.query || '').trim().toLowerCase();
    const products = s ? this._all.filter(p => p._search.includes(s)) : this._all.slice();
    this.setData({ products });
  },

  onSearchInput(e) {
    this.setData({ query: e.detail.value });
    this.applyFilter();
  },
  clearSearch() {
    this.setData({ query: '' });
    this.applyFilter();
  },

  // ── Base (no-option) product stepper ──────────────────────────────────
  bump(e) {
    const id = parseInt(e.currentTarget.dataset.id, 10);
    const dir = parseInt(e.currentTarget.dataset.dir, 10); // +1 / -1
    const p = this._all.find(x => x.id === id);
    if (!p) return;
    let q = (p.qty || 0) + dir;
    if (q < 0) q = 0;
    // Supplier-direct items hold no stock of ours — never cap their quantity.
    if (!p.ship_from_supplier && p.stock != null && q > p.stock) {
      wx.showToast({ title: this.data.copy.soldOut, icon: 'none' });
      q = p.stock;
    }
    p.qty = q;            // mutate master so qty survives filtering
    this.applyFilter();   // re-render the visible slice from the master
    this.recalc();
  },

  // ── Option sheet ──────────────────────────────────────────────────────
  async openOptions(e) {
    const id = parseInt(e.currentTarget.dataset.id, 10);
    if (!id) return;
    this.setData({ opShow: true, opLoading: true, opGroups: [], opProduct: null, opQty: 1 });
    try {
      const resp = await api.get('/api/retail/products/' + id);
      const p = resp?.data || resp;
      const L = this.data.lang;
      const cn = L === 'cn';
      const groups = (p.options || []).map(o => ({
        id: o.id,
        question: lang.pick(o.question_en, o.question_cn, L),
        type: o.type,
        is_required: !!o.is_required,
        choices: (o.choices || []).map(c => {
          const soldOut = !!c.stock_product_id && c.addon_available === false;
          const isDefault = !!c.is_default && !soldOut;
          return {
            id: c.id,
            label: lang.pick(c.label_en, c.label_cn, L),
            delta: Number(c.price_delta) || 0,
            delta_text: deltaText(c.price_delta, cn),
            sold_out: soldOut,
            // Pre-pick defaults (single: first default; multi: every default).
            picked: isDefault,
          };
        }),
      }));
      // For single groups, keep only ONE default picked.
      groups.forEach(g => {
        if (g.type !== 'multi') {
          let seen = false;
          g.choices.forEach(c => {
            if (c.picked && !seen) { seen = true; } else { c.picked = false; }
          });
          // Required single with exactly one choice → auto-pick it.
          if (g.is_required && g.choices.length === 1 && !g.choices[0].sold_out) g.choices[0].picked = true;
        }
      });
      this.setData({
        opProduct: { id: p.id, name: lang.pick(p.name_en, p.name_cn, L), base_price: effPrice(p) },
        opGroups: groups,
        opLoading: false,
      });
      this.recalcSheet();
    } catch (err) {
      this.setData({ opShow: false, opLoading: false });
      wx.showToast({ title: err.message, icon: 'none' });
    }
  },

  onChoiceTap(e) {
    const gi = parseInt(e.currentTarget.dataset.gi, 10);
    const ci = parseInt(e.currentTarget.dataset.ci, 10);
    const groups = this.data.opGroups.map(g => ({ ...g, choices: g.choices.map(c => ({ ...c })) }));
    const g = groups[gi];
    const c = g.choices[ci];
    if (!g || !c || c.sold_out) return;
    if (g.type === 'multi') {
      c.picked = !c.picked;                 // toggle
    } else {
      g.choices.forEach((x, i) => { x.picked = i === ci; });  // radio
    }
    this.setData({ opGroups: groups });
    this.recalcSheet();
  },

  opBumpQty(e) {
    const dir = parseInt(e.currentTarget.dataset.dir, 10);
    let q = (this.data.opQty || 1) + dir;
    if (q < 1) q = 1;
    this.setData({ opQty: q });
    this.recalcSheet();
  },

  recalcSheet() {
    const base = this.data.opProduct ? this.data.opProduct.base_price : 0;
    let delta = 0;
    for (const g of this.data.opGroups) for (const c of g.choices) if (c.picked) delta += c.delta;
    const unit = Math.max(0, base + delta);
    this.setData({ opTotalDisp: '¥' + (unit * this.data.opQty).toFixed(2) });
  },

  closeOptions() { this.setData({ opShow: false }); },
  noop() {},

  // Validate required groups, then add (or increment) an option line.
  addOptionLine() {
    const cn = this.data.lang === 'cn';
    // Required check.
    for (const g of this.data.opGroups) {
      if (g.is_required && !g.choices.some(c => c.picked)) {
        wx.showToast({ title: this.data.copy.pickRequired, icon: 'none' });
        return;
      }
    }
    const base = this.data.opProduct.base_price;
    const choices = [];
    const labels = [];
    let delta = 0;
    for (const g of this.data.opGroups) {
      for (const c of g.choices) {
        if (c.picked) { choices.push(c.id); labels.push(c.label); delta += c.delta; }
      }
    }
    const unit = Math.max(0, base + delta);
    const sortedKey = choices.slice().sort((a, b) => a - b).join(',');
    const key = 'p:' + this.data.opProduct.id + '|c:' + sortedKey;

    const lines = this.data.optionLines.map(l => ({ ...l }));
    const existing = lines.find(l => l.key === key);
    if (existing) {
      existing.qty += this.data.opQty;
      existing.line_disp = '¥' + (existing.unit_price * existing.qty).toFixed(2);
    } else {
      lines.push({
        key,
        product_id: this.data.opProduct.id,
        name: this.data.opProduct.name,
        options_label: labels.join(', '),
        unit_price: unit,
        unit_disp: '¥' + unit.toFixed(2),
        qty: this.data.opQty,
        choices,
        line_disp: '¥' + (unit * this.data.opQty).toFixed(2),
      });
    }
    this.setData({ optionLines: lines, opShow: false });
    this.recalc();
  },

  optionLineBump(e) {
    const key = e.currentTarget.dataset.key;
    const dir = parseInt(e.currentTarget.dataset.dir, 10);
    let lines = this.data.optionLines.map(l => ({ ...l }));
    const l = lines.find(x => x.key === key);
    if (!l) return;
    l.qty += dir;
    if (l.qty <= 0) lines = lines.filter(x => x.key !== key);
    else l.line_disp = '¥' + (l.unit_price * l.qty).toFixed(2);
    this.setData({ optionLines: lines });
    this.recalc();
  },

  // ── Totals ────────────────────────────────────────────────────────────
  recalc() {
    let total = 0, count = 0;
    for (const p of this._all) {
      if (p.qty > 0) { total += p.price * p.qty; count += p.qty; }
    }
    for (const l of this.data.optionLines) {
      total += l.unit_price * l.qty; count += l.qty;
    }
    this.setData({ addCount: count, addTotalDisp: '¥' + total.toFixed(2) });
  },

  // ── Pay the difference ────────────────────────────────────────────────
  async confirm() {
    if (this.data.submitting) return;
    const items = [];
    for (const p of this._all) if (p.qty > 0) items.push({ product_id: p.id, qty: p.qty });
    for (const l of this.data.optionLines) items.push({ product_id: l.product_id, qty: l.qty, choices: l.choices });
    if (!items.length) return;
    this.setData({ submitting: true });
    const cn = this.data.lang === 'cn';
    try {
      const resp = await api.post(
        '/api/retail/orders/' + this.data.orderId + '/addon/create', { items });
      const d = resp?.data || resp;

      // DEV mode (no real merchant) settles instantly.
      if (d?.dev || d?.status === 'success') {
        wx.showToast({ title: this.data.copy.added, icon: 'success' });
        return setTimeout(() => wx.navigateBack(), 700);
      }

      // PROD: WeChat Pay for the difference, then poll until the callback
      // finalizes the add-on (which injects the items into the order).
      if (d?.timeStamp) {
        wx.requestPayment({
          timeStamp: d.timeStamp, nonceStr: d.nonceStr,
          package: d.package, signType: d.signType, paySign: d.paySign,
          success: () => this.pollAddon(d.addon_id),
          fail: () => {
            this.setData({ submitting: false });
            wx.showToast({ title: this.data.copy.payIncomplete, icon: 'none' });
          },
        });
        return;
      }
      throw new Error(cn ? '支付方式暂不可用' : 'Payment unavailable');
    } catch (e) {
      this.setData({ submitting: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  // Poll the add-on status after wx.requestPayment — the async WeChat callback
  // flips it to 'success' once it injects the items. Bounded retries so we
  // never spin forever if a notify is delayed.
  pollAddon(addonId, tries = 0) {
    if (!addonId) { this.afterPaid(); return; }
    api.get('/api/retail/orders/' + this.data.orderId + '/addon/status/' + addonId)
      .then(resp => {
        const st = (resp?.data || resp)?.status;
        if (st === 'success') return this.afterPaid();
        if (tries >= 8) return this.afterPaid(); // give up gracefully; order page will catch up
        setTimeout(() => this.pollAddon(addonId, tries + 1), 1000);
      })
      .catch(() => {
        if (tries >= 8) return this.afterPaid();
        setTimeout(() => this.pollAddon(addonId, tries + 1), 1000);
      });
  },

  afterPaid() {
    this.setData({ submitting: false });
    wx.showToast({ title: this.data.copy.added, icon: 'success' });
    setTimeout(() => wx.navigateBack(), 700);
  },

  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/me/me' }) }); },
});
