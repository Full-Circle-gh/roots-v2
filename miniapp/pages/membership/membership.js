// Membership — Roots Club tier page. Shows the customer's current tier,
// progress to the next tier (lifetime_spend / next_threshold), perks per
// tier. Tier definitions are local for now (per design handoff §07);
// later they could come from storefront_config.

const api    = require('../../utils/api');
const config = require('../../utils/config');

const TIERS = [
  {
    key: 'seed',  name_en: 'Seed',    name_cn: '种子',
    color: 'corn',   threshold: 0,
    perks_en: ['5% off your first order', 'Member newsletter'],
    perks_cn: ['首单 5% 折扣', '会员通讯'],
  },
  {
    key: 'sprout', name_en: 'Sprout', name_cn: '幼苗',
    color: 'pea',  threshold: 500,
    perks_en: ['10% off all orders', 'Early access to drops', 'Free shipping ¥299+'],
    perks_cn: ['全场 10% 折扣', '新品优先购', '满 ¥299 包邮'],
  },
  {
    key: 'root',   name_en: 'Root',   name_cn: '根',
    color: 'forest', threshold: 2000,
    perks_en: ['15% off all orders', 'Early access to drops', 'Free shipping ¥199+', 'Birthday gift'],
    perks_cn: ['全场 15% 折扣', '新品优先购', '满 ¥199 包邮', '生日礼物'],
  },
  {
    key: 'tree',   name_en: 'Tree',   name_cn: '大树',
    color: 'ink',  threshold: 5000,
    perks_en: ['20% off all orders', 'Early access to drops', 'Free shipping (no minimum)', 'Birthday gift', 'Exclusive tasting events'],
    perks_cn: ['全场 20% 折扣', '新品优先购', '免邮 (无门槛)', '生日礼物', '专属品鉴活动'],
  },
];

Page({
  data: {
    customer: null,
    currentTier: TIERS[0],
    nextTier: null,
    spend: 0,
    spendDisplay: '¥0',
    progressPct: 0,
    progressLabel: '',
    tiers: [],
    lang: 'en',
    leaderboardEnabled: false,
    leaderboardLinkLabel: 'View leaderboard',
    copy: {
      kicker: 'ROOTS CLUB · 会员',
      title: 'Grow with us.',
      subhead: 'Earn perks on every order. Climb the tree.',
      youAreHere: "YOU'RE HERE",
      nextLabel: 'NEXT',
      ofLabel: '/',
      perksLabel: 'PERKS',
      reqLabel: 'Spend',
    },
  },

  goLeaderboard() {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard' });
  },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.applyLangCopy();
    this.refresh();
  },

  applyLangCopy() {
    this.setData({
      leaderboardLinkLabel: this.data.lang === 'cn' ? '查看排行榜' : 'View leaderboard',
    });
    if (this.data.lang !== 'cn') return;
    this.setData({
      copy: {
        kicker: 'ROOTS 会员',
        title: '一起成长。',
        subhead: '每次下单解锁福利，向上生长。',
        youAreHere: '当前等级',
        nextLabel: '下一级',
        ofLabel: '/',
        perksLabel: '会员权益',
        reqLabel: '累计',
      },
    });
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }
    let customer = null;
    try {
      customer = await api.get('/api/retail/customer');
    } catch (e) {
      console.warn('[membership] customer load failed:', e.message);
    }

    const L = this.data.lang;
    const spend = Number(customer?.lifetime_spend) || 0;
    const currentKey = customer?.tier_key || 'seed';
    const currentIdx = Math.max(0, TIERS.findIndex(t => t.key === currentKey));
    const currentTier = TIERS[currentIdx];
    const nextTier = TIERS[currentIdx + 1] || null;

    let progressPct = 100;
    let progressLabel = (L === 'cn' ? '最高等级 · 大树' : 'Top tier · Tree');
    if (nextTier) {
      const span = nextTier.threshold - currentTier.threshold;
      progressPct = Math.max(0, Math.min(100, ((spend - currentTier.threshold) / span) * 100));
      const left = nextTier.threshold - spend;
      progressLabel = (L === 'cn' ? '还差 ¥' : '¥') + Math.max(0, Math.floor(left)) + (L === 'cn' ? ' 升到' : ' to ') + (L === 'cn' ? nextTier.name_cn : nextTier.name_en);
    }

    const tiers = TIERS.map((t, i) => ({
      ...t,
      name: L === 'cn' ? t.name_cn : t.name_en,
      perks: L === 'cn' ? t.perks_cn : t.perks_en,
      reqDisplay: '¥' + t.threshold + '+',
      current: i === currentIdx,
      reached: i <= currentIdx,
    }));

    let leaderboardEnabled = false;
    try {
      const cfg = await config.load();
      leaderboardEnabled = !!(cfg && cfg.leaderboard && cfg.leaderboard.config && cfg.leaderboard.config.enabled);
    } catch {}

    this.setData({
      customer,
      currentTier: { ...currentTier, name: L === 'cn' ? currentTier.name_cn : currentTier.name_en },
      nextTier:    nextTier ? { ...nextTier, name: L === 'cn' ? nextTier.name_cn : nextTier.name_en } : null,
      spend,
      spendDisplay: '¥' + spend.toFixed(0),
      progressPct,
      progressLabel,
      tiers,
      leaderboardEnabled,
    });
  },

  goShop() { wx.switchTab({ url: '/pages/shop/shop' }); },
});
