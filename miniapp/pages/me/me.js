// Me tab — customer profile, order-status buckets, language switcher.
// Hits /api/retail/customer (profile + addresses) and /api/retail/orders/stats
// (status counts) in parallel.

const api    = require('../../utils/api');
const lang   = require('../../utils/lang');
const config = require('../../utils/config');

const TIER_LEVEL = { seed: 1, sprout: 2, root: 3, tree: 4 };
const TIER_NAME_EN = { seed: 'Seed', sprout: 'Sprout', root: 'Root', tree: 'Tree' };
const TIER_NAME_CN = { seed: '种子', sprout: '幼苗', root: '根', tree: '大树' };

const COPY_EN = {
  welcomeKicker: 'WELCOME',
  memberSince: 'MEMBER SINCE',
  memberLvl: 'LVL',
  welcome: 'Hello, you.',
  bindCta: 'Tap to bind your WeChat profile',
  balance: 'Balance',
  coupons: 'Coupons',
  points: 'Points',
  ordersTitle: 'My orders',
  allOrders: 'ALL ORDERS',
  ordersWord: 'orders',
  bUnpaid:    'Unpaid',
  bPending:   'Pending',
  bPreparing: 'Preparing',
  bSent:      'Sent',
  bReview:    'Review',
  langLabel: 'Language',
  menuAddresses: 'Delivery addresses',
  menuAddressesCn: '收货地址',
  menuWallet: 'Wallet & points',
  menuWalletCn: '钱包积分',
  menuTopup: 'Top up',
  menuTopupCn: '充值',
  topupMeta: 'Add credit, earn bonus points',
  menuCoupons: 'Coupons',
  menuCouponsCn: '优惠券',
  couponsMeta: 'active',
  menuInvoices: 'Invoices',
  menuInvoicesCn: '我的发票',
  menuNotif: 'Notifications',
  menuNotifCn: '通知',
  notifMeta: 'new',
  menuFavorites: 'Favorites',
  menuFavoritesCn: '收藏夹',
  favoritesMeta: 'saved',
  menuMembership: 'Membership',
  menuMembershipCn: '会员',
  menuAffiliate: 'Refer a friend',
  menuAffiliateCn: '推广计划',
  affiliateMeta: '¥30 for you, ¥30 for them',
  menuAbout: 'About Roots',
  menuAboutCn: '关于我们',
  aboutMeta: 'Our story',
  menuFaq: 'Help & FAQ',
  menuFaqCn: '帮助中心',
  faqMeta: 'Answers to common questions',
  menuBug: 'Found a bug?',
  menuBugCn: '报告问题',
  bugMeta: 'Tell us what broke',
  menuVoting: 'Your say',
  menuVotingCn: '投票',
  votingMeta: 'Help shape the menu',
  menuTour: 'Take the tour',
  menuTourCn: '查看教程',
  tourMeta: 'See the welcome screen again',
  noAddressMeta: 'Tap to add an address',
};

const COPY_CN = {
  welcomeKicker: '欢迎',
  memberSince: '会员自',
  memberLvl: '等级',
  welcome: '你好。',
  bindCta: '点击绑定微信资料',
  balance: '余额',
  coupons: '优惠券',
  points: '积分',
  ordersTitle: '我的订单',
  allOrders: '查看全部',
  ordersWord: '订单',
  bUnpaid:    '待付款',
  bPending:   '待确认',
  bPreparing: '备货中',
  bSent:      '已发货',
  bReview:    '待评价',
  langLabel: '语言',
  menuAddresses: '收货地址',
  menuAddressesCn: 'DELIVERY ADDRESSES',
  menuWallet: '钱包积分',
  menuWalletCn: 'WALLET & POINTS',
  menuTopup: '充值',
  menuTopupCn: 'TOP UP',
  topupMeta: '充值得积分,余额随时用',
  menuCoupons: '优惠券',
  menuCouponsCn: 'COUPONS',
  couponsMeta: '张可用',
  menuInvoices: '我的发票',
  menuInvoicesCn: 'INVOICES',
  menuNotif: '通知',
  menuNotifCn: 'NOTIFICATIONS',
  notifMeta: '条未读',
  menuFavorites: '收藏夹',
  menuFavoritesCn: 'FAVORITES',
  favoritesMeta: '件已收藏',
  menuMembership: '会员',
  menuMembershipCn: 'MEMBERSHIP',
  menuAffiliate: '推广计划',
  menuAffiliateCn: 'REFER A FRIEND',
  affiliateMeta: '推荐好友双方各得 ¥30',
  menuAbout: '关于我们',
  menuAboutCn: 'ABOUT ROOTS',
  aboutMeta: '我们的故事',
  menuFaq: '帮助中心',
  menuFaqCn: 'HELP & FAQ',
  faqMeta: '常见问题解答',
  menuBug: '报告问题',
  menuBugCn: 'FOUND A BUG?',
  bugMeta: '告诉我们哪里出错了',
  menuVoting: '投票',
  menuVotingCn: 'YOUR SAY',
  votingMeta: '一起决定下一款产品',
  menuTour: '查看教程',
  menuTourCn: 'TAKE THE TOUR',
  tourMeta: '重新观看欢迎引导',
  noAddressMeta: '点击添加地址',
};

// Canonical menu-row catalogue. Order here is the default; the operator can
// reorder/hide rows from the Mini App Backend (Settings → Me page menu),
// persisted to storefront_config['me_page.rows'] and read back via
// /api/retail/config → config.me_page.rows. `titleKey` is the COPY_* base
// key (its `…Cn` sibling is the secondary label). accent = highlighted row.
const ROW_DEFS = [
  { id: 'notif',      handler: 'goNotifications', titleKey: 'menuNotif' },
  { id: 'addresses',  handler: 'goAddresses',     titleKey: 'menuAddresses' },
  { id: 'wallet',     handler: 'goWallet',        titleKey: 'menuWallet' },
  { id: 'topup',      handler: 'goTopup',         titleKey: 'menuTopup',     accent: true },
  { id: 'affiliate',  handler: 'goAffiliate',     titleKey: 'menuAffiliate', accent: true },
  { id: 'coupons',    handler: 'goCoupons',       titleKey: 'menuCoupons' },
  { id: 'invoices',   handler: 'goInvoices',      titleKey: 'menuInvoices' },
  { id: 'favorites',  handler: 'goFavorites',     titleKey: 'menuFavorites' },
  { id: 'membership', handler: 'goMembership',    titleKey: 'menuMembership' },
  { id: 'voting',     handler: 'goVoting',        titleKey: 'menuVoting' },
  { id: 'about',      handler: 'goAbout',         titleKey: 'menuAbout' },
  { id: 'faq',        handler: 'goFaq',           titleKey: 'menuFaq' },
  { id: 'bug',        handler: 'goBugReport',     titleKey: 'menuBug' },
  { id: 'tour',       handler: 'goTour',          titleKey: 'menuTour' },
];
const ROW_DEF_MAP = ROW_DEFS.reduce((m, r) => (m[r.id] = r, m), {});

Page({
  data: {
    customer: null,
    stats: { unpaid: 0, pending: 0, preparing: 0, to_ship: 0, shipped: 0, to_review: 0, after_sales: 0, total: 0 },
    defaultAddrPreview: '',
    balanceDisplay: '0.00',
    memberYear: '',
    tierLevel: 1,
    tierName: 'Seed',
    avatarPreview: '',
    lang: 'en',
    loading: false,
    copy: COPY_EN,
    // "Take the tour" row visibility. Hidden when the operator sets
    // onboarding show_to='off' in /cms — "disabled" means the welcome
    // screen is gone for good, both the auto-gate (home.js) and this
    // manual re-tour entry point. Default true so a config miss still
    // lets users re-watch.
    tourEnabled: true,
    // Operator-defined row layout (config.me_page.rows): array of
    // { id, enabled }. null = use the ROW_DEFS default order, all shown.
    meRowsConfig: null,
    // Fully resolved, render-ready menu rows (built by buildRows()).
    menuRows: [],
    // Brand footer — wordmark / tagline / credit line. Hydrated from
    // app.globalData.config.brand.me_footer (set by the operator in the Mini
    // App Backend → Settings → Mini-app footer). Defaults reflect the SaaS
    // platform (Full Circle · Clarity with code) so a brand-new tenant whose
    // operator hasn't customised the footer yet sees Full Circle, not Roots.
    // Roots' production DB is seeded with its own row in database.js so its
    // customers continue to see the Roots wordmark + tagline unchanged.
    footer: {
      wordmark_image: '',
      wordmark_text:  'Full Circle',
      tagline:        'Clarity with code',
      credit:         'Powered by Full Circle',
    },
  },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.applyLangCopy();
    this.applyFooter();
    this.refresh();
    const tb = this.getTabBar && this.getTabBar();
    if (tb && tb.setSelected) tb.setSelected('pages/me/me');
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  applyLangCopy() {
    this.setData({ copy: this.data.lang === 'cn' ? COPY_CN : COPY_EN });
    this.buildRows();
  },

  // Resolve the visible row order from meRowsConfig (operator layout) on top
  // of the ROW_DEFS catalogue. Saved order/visibility wins; any row the
  // operator's saved config predates (a newly shipped row) is appended and
  // shown by default so the menu never silently drops a feature. The tour row
  // is always dropped when onboarding is disabled, regardless of layout.
  resolveRowOrder() {
    const cfg = Array.isArray(this.data.meRowsConfig) ? this.data.meRowsConfig : null;
    let ordered;
    if (cfg && cfg.length) {
      const seen = new Set();
      ordered = [];
      for (const r of cfg) {
        if (!r || !ROW_DEF_MAP[r.id] || seen.has(r.id)) continue;
        seen.add(r.id);
        if (r.enabled !== false) ordered.push(r.id);
      }
      for (const def of ROW_DEFS) if (!seen.has(def.id)) ordered.push(def.id);
    } else {
      ordered = ROW_DEFS.map(r => r.id);
    }
    if (!this.data.tourEnabled) ordered = ordered.filter(id => id !== 'tour');
    return ordered;
  },

  // Compute the per-row meta line (dynamic counts / previews) for an id.
  rowMeta(id) {
    const c = this.data.copy;
    const cust = this.data.customer || {};
    switch (id) {
      case 'notif':      return this.data.notifUnread > 0 ? (this.data.notifUnread + ' ' + c.notifMeta) : '';
      case 'addresses':  return this.data.defaultAddrPreview || c.noAddressMeta;
      case 'wallet':     return '¥' + this.data.balanceDisplay + ' · ' + (cust.points_balance || 0) + ' pts';
      case 'topup':      return c.topupMeta;
      case 'affiliate':  return c.affiliateMeta;
      case 'coupons':    return (cust.coupon_count || 0) + ' ' + c.couponsMeta;
      case 'invoices':   return '';
      case 'favorites':  return (cust.favorite_count || 0) + ' ' + c.favoritesMeta;
      case 'membership': return this.data.tierName + ' · LVL ' + this.data.tierLevel;
      case 'voting':     return c.votingMeta;
      case 'about':      return c.aboutMeta;
      case 'faq':        return c.faqMeta;
      case 'bug':        return c.bugMeta;
      case 'tour':       return c.tourMeta;
      default:           return '';
    }
  },

  buildRows() {
    const c = this.data.copy;
    const notif = this.data.notifUnread || 0;
    const rows = this.resolveRowOrder().map(id => {
      const def = ROW_DEF_MAP[id];
      return {
        id,
        handler: def.handler,
        title:   c[def.titleKey],
        titleCn: c[def.titleKey + 'Cn'],
        meta:    this.rowMeta(id),
        badge:   id === 'notif' && notif > 0 ? (notif > 99 ? '99+' : notif) : '',
        accent:  id === 'notif' ? notif > 0 : !!def.accent,
      };
    });
    this.setData({ menuRows: rows });
  },

  // Resolve the brand-footer fields from /api/retail/config. We await
  // config.load() (60s in-memory cache so it's a no-op on warm starts)
  // because app.globalData.config is fire-and-forget at launch — reading
  // it directly races with the network and would show the Full Circle
  // fallbacks on Roots' first me-page open instead of Roots' own footer.
  // Called from onShow + switchLang.
  async applyFooter() {
    let cfg = {};
    let tourEnabled = true;
    let meRowsConfig = null;
    try {
      const full = await config.load(false);
      cfg = (full && full.brand && full.brand.me_footer) || {};
      // show_to='off' disables onboarding entirely → hide the re-tour row.
      tourEnabled = full?.onboarding?.show_to !== 'off';
      // Operator's Me-page row layout (order + visibility).
      if (Array.isArray(full?.me_page?.rows)) meRowsConfig = full.me_page.rows;
    } catch {}
    const lang = this.data.lang;
    const tEN = (cfg.tagline_en || '').trim();
    const tCN = (cfg.tagline_cn || '').trim();
    // SaaS-default tagline is Full Circle's "Clarity with code". Roots and
    // other tenants override per-language via the backend footer card.
    const tagline = (tEN && tCN) ? (tEN + ' · ' + tCN)
                                  : (tEN || tCN || 'Clarity with code');
    const credit = lang === 'cn'
      ? (cfg.credit_cn || '由 Full Circle 提供技术支持')
      : (cfg.credit_en || 'Powered by Full Circle');
    // wordmark_text falls back to 'Full Circle' only when no image is set —
    // otherwise wx:if (image) wins anyway and the text wouldn't render.
    this.setData({
      tourEnabled,
      meRowsConfig,
      footer: {
        wordmark_image: cfg.wordmark_image || '',
        wordmark_text:  cfg.wordmark_text  || (cfg.wordmark_image ? '' : 'Full Circle'),
        tagline,
        credit,
      },
    });
    this.buildRows();
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }
    if (!app.globalData.token) return;
    this.setData({ loading: true });
    try {
      const [cust, stats, notif] = await Promise.all([
        api.get('/api/retail/customer').catch(() => null),
        api.get('/api/retail/orders/stats').catch(() => ({ data: {} })),
        api.get('/api/retail/notifications/unread-count').catch(() => null),
      ]);
      const statsData = (stats && stats.data) || stats || {};
      const next = { loading: false };
      next.notifUnread = (notif && notif.count) || 0;
      if (cust) {
        next.customer = cust;
        next.balanceDisplay = Number(cust.balance || 0).toFixed(2);
        next.avatarPreview = cust.avatar_url
          ? (/^https?:\/\//.test(cust.avatar_url) ? cust.avatar_url : api.BASE + cust.avatar_url)
          : '';
        const year = cust.created_at ? String(cust.created_at).slice(0, 4) : '';
        next.memberYear = year;
        const tierKey = cust.tier_key || 'seed';
        next.tierLevel = TIER_LEVEL[tierKey] || 1;
        next.tierName  = (this.data.lang === 'cn' ? TIER_NAME_CN : TIER_NAME_EN)[tierKey] || 'Seed';
        const addrs = Array.isArray(cust.addresses) ? cust.addresses : [];
        const def = addrs.find(a => a.is_default) || addrs[0];
        if (def) {
          const bits = [def.city, def.address].filter(Boolean);
          const extra = addrs.length > 1 ? ' +' + (addrs.length - 1) : '';
          next.defaultAddrPreview = (bits.join(' ') || def.recipient_name || '') + extra;
        } else {
          next.defaultAddrPreview = '';
        }
      }
      next.stats = {
        unpaid:      statsData.unpaid || 0,
        pending:     statsData.pending || 0,
        preparing:   statsData.preparing || 0,
        to_ship:     statsData.to_ship || 0,
        shipped:     statsData.shipped || 0,
        to_review:   statsData.to_review || 0,
        after_sales: statsData.after_sales || 0,
        total:       statsData.total || 0,
      };
      this.setData(next);
      this.buildRows();
    } catch (e) {
      console.warn('[me] refresh failed:', e.message);
      this.setData({ loading: false });
    }
  },

  // Single tap dispatcher for the data-driven menu rows — each row carries
  // its handler name in data-handler.
  onRowTap(e) {
    const fn = e.currentTarget.dataset.handler;
    if (fn && typeof this[fn] === 'function') this[fn]();
  },

  switchLang(e) {
    const next = e.currentTarget.dataset.lang;
    lang.set(next);
    this.setData({ lang: next });
    this.applyLangCopy();
    this.applyFooter();
    this.refresh();
  },

  goOrders()         { wx.navigateTo({ url: '/pages/orders/orders' }); },
  goOrdersFiltered(e) {
    const status = e.currentTarget.dataset.status;
    // Review bucket opens a per-item list of unreviewed delivered items,
    // not an order-list filtered by 'delivered' (which would include
    // already-reviewed orders and mismatch the badge count).
    if (status === 'to_review') {
      wx.navigateTo({ url: '/pages/pending-reviews/pending-reviews' });
      return;
    }
    const url = status
      ? '/pages/orders/orders?status=' + encodeURIComponent(status)
      : '/pages/orders/orders';
    wx.navigateTo({ url });
  },
  goAddresses()  { wx.navigateTo({ url: '/pages/addresses/addresses' }); },
  goMembership() { wx.navigateTo({ url: '/pages/membership/membership' }); },
  goAffiliate()  { wx.navigateTo({ url: '/pages/affiliate/affiliate' }); },
  goWallet()     { wx.navigateTo({ url: '/pages/wallet/wallet' }); },
  goTopup()      { wx.navigateTo({ url: '/pages/topup/topup' }); },
  goCoupons()    { wx.navigateTo({ url: '/pages/coupons/coupons' }); },
  goInvoices()   { wx.navigateTo({ url: '/pages/invoices/invoices' }); },
  goNotifications() { wx.navigateTo({ url: '/pages/notifications/notifications' }); },
  goFavorites()  { wx.navigateTo({ url: '/pages/favorites/favorites' }); },
  goProfile()    { wx.navigateTo({ url: '/pages/profile/profile' }); },
  goAbout()      { wx.navigateTo({ url: '/pages/about/about' }); },
  goFaq()        { wx.navigateTo({ url: '/pages/faq/faq' }); },
  goBugReport()  { wx.navigateTo({ url: '/pages/feedback/feedback' }); },
  goVoting()     { wx.navigateTo({ url: '/pages/voting/voting' }); },
  // User-initiated re-tour. Clears the onboarded flag so the next Home
  // load also re-gates correctly under any mode, then re-launches into
  // the onboarding page. Skip/Next will re-stamp the current version
  // and send the user back to Home.
  goTour() {
    try { wx.removeStorageSync('onboarded'); } catch {}
    wx.reLaunch({ url: '/pages/onboarding/onboarding' });
  },
});
