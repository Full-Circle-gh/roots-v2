// Me tab — customer profile, order-status buckets, language switcher.
// Hits /api/retail/customer (profile + addresses) and /api/retail/orders/stats
// (status counts) in parallel.

const api  = require('../../utils/api');
const lang = require('../../utils/lang');

const TIER_LEVEL = { seed: 1, sprout: 2, root: 3, tree: 4 };
const TIER_NAME_EN = { seed: 'Seed', sprout: 'Sprout', root: 'Root', tree: 'Tree' };
const TIER_NAME_CN = { seed: '种子', sprout: '幼苗', root: '根', tree: '大树' };

const COPY_EN = {
  welcomeKicker: 'WELCOME · 欢迎',
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
  menuVoting: 'Your say',
  menuVotingCn: '投票',
  votingMeta: 'Help shape the menu',
  noAddressMeta: 'Tap to add an address',
};

const COPY_CN = {
  welcomeKicker: '欢迎 · WELCOME',
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
  menuVoting: '投票',
  menuVotingCn: 'YOUR SAY',
  votingMeta: '一起决定下一款产品',
  noAddressMeta: '点击添加地址',
};

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
  },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.applyLangCopy();
    this.refresh();
    const tb = this.getTabBar && this.getTabBar();
    if (tb && tb.setSelected) tb.setSelected('pages/me/me');
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  applyLangCopy() {
    this.setData({ copy: this.data.lang === 'cn' ? COPY_CN : COPY_EN });
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }
    if (!app.globalData.token) return;
    this.setData({ loading: true });
    try {
      const [cust, stats] = await Promise.all([
        api.get('/api/retail/customer').catch(() => null),
        api.get('/api/retail/orders/stats').catch(() => ({ data: {} })),
      ]);
      const statsData = (stats && stats.data) || stats || {};
      const next = { loading: false };
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
    } catch (e) {
      console.warn('[me] refresh failed:', e.message);
      this.setData({ loading: false });
    }
  },

  switchLang(e) {
    const next = e.currentTarget.dataset.lang;
    lang.set(next);
    this.setData({ lang: next });
    this.applyLangCopy();
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
  goFavorites()  { wx.navigateTo({ url: '/pages/favorites/favorites' }); },
  goProfile()    { wx.navigateTo({ url: '/pages/profile/profile' }); },
  goAbout()      { wx.navigateTo({ url: '/pages/about/about' }); },
  goFaq()        { wx.navigateTo({ url: '/pages/faq/faq' }); },
  goVoting()     { wx.navigateTo({ url: '/pages/voting/voting' }); },
});
