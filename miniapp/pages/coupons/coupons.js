// Coupons — dedicated vouchers wallet page. Three tabs: Active, Used,
// Expired. Active = customer's granted vouchers + public browseable ones.
// Used = past orders that applied a voucher_code, plus any granted
// voucher whose used_at is set. Expired = granted vouchers that ran past
// their expiry without being used.
//
// Redeeming a code calls /api/retail/vouchers/validate (subtotal = 0 so
// only structural checks run) — on success we surface a toast and refresh
// the list. The actual voucher_code is applied at checkout.

const api  = require('../../utils/api');
const lang = require('../../utils/lang');

// Accent palette — keeps the riso/sticker look of the design.
const STUB_ACCENTS = ['#CCD900', '#FFAF60', '#B2CFED', '#F4B8CB', '#F2CA6C', '#E96174'];

// Pick a stable accent per voucher code so colors don't shuffle between
// renders. Hashes the code into the palette.
function accentFor(code) {
  if (!code) return STUB_ACCENTS[0];
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) | 0;
  return STUB_ACCENTS[Math.abs(h) % STUB_ACCENTS.length];
}

function fmtDate(s) {
  if (!s) return '';
  // Sqlite "YYYY-MM-DD HH:MM:SS" or ISO — keep first 10 chars
  return String(s).slice(0, 10);
}

function bigSubFor(v, L) {
  const value = Number(v.value || 0);
  const threshold = Number(v.min_subtotal || 0);
  const thrTxt = threshold > 0
    ? (L === 'cn' ? '满¥' + threshold : 'off ¥' + threshold + '+')
    : (L === 'cn' ? '无门槛' : 'no minimum');
  if (v.type === 'percent') {
    return { big: value + '%', sub: thrTxt };
  }
  if (v.type === 'free_shipping') {
    return { big: L === 'cn' ? '免运' : 'FREE', sub: L === 'cn' ? '运费' : 'shipping' };
  }
  // fixed_amount
  return { big: '¥' + value, sub: thrTxt };
}

Page({
  data: {
    lang: 'en',
    codeInput: '',
    redeeming: false,
    activeTab: 'active',
    tabs: [
      { id: 'active',  label: 'ACTIVE',  count: 0 },
      { id: 'used',    label: 'USED',    count: 0 },
      { id: 'expired', label: 'EXPIRED', count: 0 },
    ],
    counts: { active: 0, used: 0, expired: 0 },
    all: { active: [], used: [], expired: [] },
    visible: [],
    copy: {
      kicker: 'COUPONS · 优惠券',
      title: 'Your vouchers.',
      activeWord: 'ACTIVE',
      redeemPlaceholder: 'Enter a code · 输入优惠码',
      redeem: 'REDEEM',
      redeeming: 'CHECKING…',
      expires: 'EXPIRES',
      useNow: 'USE NOW',
      tabActive: 'ACTIVE',
      tabUsed: 'USED',
      tabExpired: 'EXPIRED',
      emptyTitle: 'Nothing here.',
      emptySub: 'New coupons arrive on orders, birthdays, and member promos.',
      toastValid: 'Code accepted.',
      toastBadCode: 'Invalid code.',
      toastSavedForCheckout: 'Saved for checkout.',
    },
  },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.applyLangCopy();
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  applyLangCopy() {
    if (this.data.lang !== 'cn') return;
    this.setData({
      copy: {
        kicker: '优惠券 · COUPONS',
        title: '我的优惠券。',
        activeWord: '可用',
        redeemPlaceholder: '输入优惠码 · Enter a code',
        redeem: '兑换',
        redeeming: '检查中…',
        expires: '有效期至',
        useNow: '去使用',
        tabActive: '可用',
        tabUsed: '已用',
        tabExpired: '过期',
        emptyTitle: '暂无',
        emptySub: '订单、生日、会员活动都会送您新的优惠券。',
        toastValid: '优惠码有效。',
        toastBadCode: '无效的优惠码。',
        toastSavedForCheckout: '已保存到结算页。',
      },
    });
    this.relabelTabs();
  },

  relabelTabs() {
    const c = this.data.copy;
    const t = this.data.tabs.map(x => ({
      ...x,
      label: x.id === 'active' ? c.tabActive : x.id === 'used' ? c.tabUsed : c.tabExpired,
    }));
    this.setData({ tabs: t });
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }
    if (!app.globalData.token) return;

    try {
      const [publicRes, myRes, ordersRes] = await Promise.all([
        api.get('/api/retail/vouchers/public').catch(() => []),
        api.get('/api/retail/my-vouchers').catch(() => []),
        api.get('/api/retail/orders?limit=50').catch(() => []),
      ]);

      const unwrap = (x) => Array.isArray(x) ? x : (x?.data || []);
      const granted = unwrap(myRes);
      const publik  = unwrap(publicRes);
      const orders  = unwrap(ordersRes);

      const L = this.data.lang;

      // Build a deduped active list keyed by code. Granted (personal)
      // vouchers win over public so we don't double-show.
      const byCode = new Map();
      granted.forEach(v => {
        byCode.set(v.code, this.toTicket(v, L, { source: 'granted' }));
      });
      publik.forEach(v => {
        if (!byCode.has(v.code)) {
          byCode.set(v.code, this.toTicket(v, L, { source: 'public' }));
        }
      });
      const active = Array.from(byCode.values());

      // Used = past orders that applied a voucher_code. We do not have
      // the full voucher row here, so render a compact summary from the
      // order.
      const used = orders
        .filter(o => o.voucher_code)
        .map(o => ({
          key: 'order-' + o.order_no,
          code: o.voucher_code,
          name: (L === 'cn' ? '已使用 · 订单 #' : 'Used · Order #') + o.order_no,
          cn: '',
          tag: null,
          accent: accentFor(o.voucher_code),
          bigLabel: '−¥' + Number(o.voucher_amount || 0).toFixed(0),
          subLabel: L === 'cn' ? '抵扣' : 'discount',
          expiresDisplay: fmtDate(o.placed_at),
          dimmed: true,
          stateLabel: L === 'cn' ? '已使用' : 'USED',
        }));

      // Expired: today the public/granted endpoints filter expired rows
      // out, so we can only surface expired ones we already know about.
      // For now leave this empty — backend extension (my-vouchers-history)
      // can fill it later. Customers see USED + ACTIVE which is the bulk.
      const expired = [];

      const counts = { active: active.length, used: used.length, expired: expired.length };
      const tabs = this.data.tabs.map(t => ({ ...t, count: counts[t.id] }));

      this.setData({
        all: { active, used, expired },
        counts,
        tabs,
        visible: this.data.activeTab === 'active' ? active
               : this.data.activeTab === 'used'   ? used
               : expired,
      });
    } catch (e) {
      console.warn('[coupons] refresh failed:', e.message);
    }
  },

  toTicket(v, L, opts) {
    const { big, sub } = bigSubFor(v, L);
    const title = lang.pick(v.title_en, v.title_cn, L)
      || (L === 'cn' ? '优惠券' : 'Voucher');
    const cn = (L === 'cn' ? v.title_en : v.title_cn) || '';
    return {
      key: opts.source + '-' + v.code,
      code: v.code,
      name: title,
      cn,
      tag: opts.source === 'granted' ? (L === 'cn' ? '专属' : 'YOURS') : null,
      accent: accentFor(v.code),
      bigLabel: big,
      subLabel: sub,
      expiresDisplay: v.expires_at
        ? fmtDate(v.expires_at)
        : (L === 'cn' ? '长期有效' : 'No expiry'),
      dimmed: false,
      stateLabel: '',
    };
  },

  onTabTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.activeTab) return;
    this.setData({
      activeTab: id,
      visible: this.data.all[id] || [],
    });
  },

  onCodeInput(e) {
    this.setData({ codeInput: e.detail.value });
  },

  async onRedeem() {
    if (this.data.redeeming) return;
    const code = String(this.data.codeInput || '').trim().toUpperCase();
    if (!code) return;

    this.setData({ redeeming: true });
    try {
      // subtotal = 0 → backend skips min-subtotal gate via the
      // "not_applicable" branch, but still validates existence + active
      // status. Either response means the code itself is real.
      await api.post('/api/retail/vouchers/validate', { code, subtotal: 0 });
      wx.showToast({ title: this.data.copy.toastValid, icon: 'success' });
      this.setData({ codeInput: '' });
      this.refresh();
    } catch (err) {
      const msg = String(err && err.message || '');
      if (msg === 'not_applicable' || msg === 'per_customer_limit_reached') {
        // Code exists but doesn't apply right now — still valid enough
        // to surface; the customer will see it in the active list.
        wx.showToast({ title: this.data.copy.toastSavedForCheckout, icon: 'success' });
        this.setData({ codeInput: '' });
        this.refresh();
      } else {
        wx.showToast({ title: this.data.copy.toastBadCode, icon: 'none' });
      }
    } finally {
      this.setData({ redeeming: false });
    }
  },

  onCouponTap(e) {
    if (e.currentTarget.dataset.dimmed) return;
    this.onUseNow(e);
  },

  onUseNow(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    try { wx.setStorageSync('pending_voucher_code', code); } catch {}
    wx.switchTab({
      url: '/pages/cart/cart',
      fail: () => wx.navigateTo({ url: '/pages/cart/cart' }),
    });
  },
});
