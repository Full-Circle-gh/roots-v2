// Leaderboard — Roots Club ranking. Read-only client; all build/edit
// lives in the retail-admin "Leaderboard" tab. The endpoint returns
// pre-masked nicknames per the admin's reveal-mode choice, so this
// page only needs to format values and lay out the podium + list.

const api = require('../../utils/api');

const COPY_EN = {
  loading:        'Loading leaderboard…',
  disabled:       'The leaderboard is taking a season off. Come back later.',
  empty:          'No qualifying members yet. Be the first to climb.',
  youAre:         'YOUR RANK',
  notRankedTitle: 'NOT RANKED YET',
  notRankedSub:   'Place a paid order to start climbing the leaderboard.',
  rewardsTitle:   'REWARDS',
  metricSpend:    'By lifetime spend',
  metricPoints:   'By points balance',
  metricOrders:   'By paid orders',
  periodAll:      'All time',
  periodYear:     'Last 12 months',
  periodMonth:    'Last 30 days',
  periodWeek:     'Last 7 days',
};
const COPY_CN = {
  loading:        '加载排行榜中…',
  disabled:       '排行榜暂时关闭,稍后再来。',
  empty:          '还没有上榜会员,快来成为第一名。',
  youAre:         '您的排名',
  notRankedTitle: '尚未上榜',
  notRankedSub:   '完成一笔已付款订单即可开始上榜。',
  rewardsTitle:   '奖励',
  metricSpend:    '按累计消费',
  metricPoints:   '按积分余额',
  metricOrders:   '按已付订单数',
  periodAll:      '全部时间',
  periodYear:     '近 12 个月',
  periodMonth:    '近 30 天',
  periodWeek:     '近 7 天',
};

Page({
  data: {
    loading: true,
    disabled: false,
    lang: 'en',
    copy: COPY_EN,
    kicker: '',
    title: '',
    subhead: '',
    metaLabel: '',
    metric: 'lifetime_spend',
    entries: [],       // top 3 (with display values)
    listEntries: [],   // ranks 4..N
    me: { rank: null, value: 0, in_top_n: false },
    myValueDisplay: '',
    rewards: [],
    myCustomerId: null,
  },

  onShow() {
    const app = getApp();
    const lang = app.globalData.lang || 'en';
    this.setData({ lang, copy: lang === 'cn' ? COPY_CN : COPY_EN });
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  metricLabel(metric) {
    const c = this.data.copy;
    if (metric === 'points_balance') return c.metricPoints;
    if (metric === 'orders_count')   return c.metricOrders;
    return c.metricSpend;
  },
  periodLabel(period) {
    const c = this.data.copy;
    if (period === 'year')  return c.periodYear;
    if (period === 'month') return c.periodMonth;
    if (period === 'week')  return c.periodWeek;
    return c.periodAll;
  },
  formatValue(value, metric) {
    const v = Number(value) || 0;
    if (metric === 'lifetime_spend') return '¥' + v.toFixed(0);
    if (metric === 'points_balance') return v.toLocaleString() + (this.data.lang === 'cn' ? ' 分' : ' pts');
    if (metric === 'orders_count')   return v.toLocaleString() + (this.data.lang === 'cn' ? ' 单' : ' orders');
    return String(v);
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }

    let myId = null;
    try {
      const cust = await api.get('/api/retail/customer');
      myId = cust && cust.id;
    } catch (e) { /* not signed in — leaderboard call below will 401 */ }

    let data;
    try {
      data = await api.get('/api/retail/leaderboard');
    } catch (e) {
      if (e.status === 404) {
        this.setData({ loading: false, disabled: true });
        return;
      }
      console.warn('[leaderboard] load failed', e.message);
      this.setData({ loading: false });
      return;
    }

    const lang = this.data.lang;
    const cfg = data.config || {};
    const all = (data.entries || []).map((e) => ({
      ...e,
      isMe: e.rank === (data.me && data.me.rank),
      valueDisplay: this.formatValue(e.value, cfg.metric),
    }));
    const entries = all.slice(0, 3);
    const listEntries = all.slice(3);

    const rewards = [];
    if (cfg.reward_top1_en || cfg.reward_top1_cn) rewards.push({ tag: 'TOP 1',  text: lang === 'cn' ? (cfg.reward_top1_cn  || cfg.reward_top1_en)  : (cfg.reward_top1_en  || cfg.reward_top1_cn) });
    if (cfg.reward_top3_en || cfg.reward_top3_cn) rewards.push({ tag: 'TOP 3',  text: lang === 'cn' ? (cfg.reward_top3_cn  || cfg.reward_top3_en)  : (cfg.reward_top3_en  || cfg.reward_top3_cn) });
    if (cfg.reward_top10_en || cfg.reward_top10_cn) rewards.push({ tag: 'TOP 10', text: lang === 'cn' ? (cfg.reward_top10_cn || cfg.reward_top10_en) : (cfg.reward_top10_en || cfg.reward_top10_cn) });

    const me = data.me || { rank: null, value: 0, in_top_n: false };
    this.setData({
      loading: false,
      disabled: false,
      myCustomerId: myId,
      kicker: lang === 'cn' ? (cfg.kicker_cn || cfg.kicker_en || '') : (cfg.kicker_en || cfg.kicker_cn || ''),
      title:  lang === 'cn' ? (cfg.title_cn  || cfg.title_en  || '') : (cfg.title_en  || cfg.title_cn  || ''),
      subhead: lang === 'cn' ? (cfg.subhead_cn || cfg.subhead_en || '') : (cfg.subhead_en || cfg.subhead_cn || ''),
      metaLabel: this.metricLabel(cfg.metric) + ' · ' + this.periodLabel(cfg.period),
      metric: cfg.metric || 'lifetime_spend',
      entries,
      listEntries,
      me,
      myValueDisplay: this.formatValue(me.value, cfg.metric),
      rewards,
    });
  },
});
