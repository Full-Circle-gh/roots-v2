// Wallet + Points — combined screen with tabs (design page #16).
// Wallet history = top-up transactions ledger.
// Points history = retail_points_transactions ledger.

const api  = require('../../utils/api');

const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Map a points-ledger source to the colored pip + filter bucket.
function classifyPointsRow(row) {
  const src = row.source;
  let type, bucket;
  if (src === 'order_earn')       { type = 'earn';   bucket = 'earn'; }
  else if (src === 'topup_bonus') { type = 'bonus';  bucket = 'earn'; }
  else if (src === 'order_redeem'){ type = 'redeem'; bucket = 'redeem'; }
  else if (src === 'expiry')      { type = 'expiry'; bucket = 'redeem'; }
  else if (src === 'refund_reverse'){ type = 'redeem'; bucket = 'redeem'; }
  else if (src === 'poll_vote')   { type = 'bonus';  bucket = 'earn'; }
  else if (src === 'admin_adjust'){ type = 'reward'; bucket = row.delta >= 0 ? 'earn' : 'redeem'; }
  else                            { type = 'reward'; bucket = row.delta >= 0 ? 'earn' : 'redeem'; }
  return { type, bucket };
}

function formatDateParts(iso) {
  if (!iso) return { day: '', mon: '', time: '' };
  // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC.
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return { day: '', mon: '', time: '' };
  return {
    day:  String(parseInt(m[3], 10)),
    mon:  MONTH_ABBR[parseInt(m[2], 10) - 1] || '',
    time: m[4] + ':' + m[5],
  };
}

const COPY = {
  en: {
    navTitle:     'Wallet & Points',
    kicker:       'BALANCE',
    title:        'Wallet & Points.',
    walletLabel:  'WALLET',
    pointsLabel:  'POINTS',
    available:    'AVAILABLE',
    cardLabel:    'PREPAID',
    neverExp:     'NEVER EXPIRES',
    topup:        'TOP UP →',
    withdraw:     'WITHDRAW',
    redeem:       'REDEEM →',
    howEarn:      'HOW TO EARN',
    pointsHint:   '1 pt = ¥0.10 off.',
    earned:       'EARNED THIS MONTH',
    redeemed:     'REDEEMED',
    history:      'HISTORY',
    record:       'RECORD',
    filterAll:    'ALL',
    filterIn:     '+ IN',
    filterOut:    '− OUT',
    filterEarn:   '+ EARN',
    filterRedeem: '− REDEEM',
    empty:        'No transactions yet',
    withdrawSoon: 'Withdrawals via customer service for now.',
    redeemSoon:   'Apply points at checkout.',
    earnExplain:  'Earn 1 point per ¥100 spent. Plus bonus points on every top-up.',
  },
  cn: {
    navTitle:     '钱包与积分',
    kicker:       '余额',
    title:        '钱包与积分。',
    walletLabel:  '钱包',
    pointsLabel:  '积分',
    available:    '可用',
    cardLabel:    '预付',
    neverExp:     '永不过期',
    topup:        '充值 →',
    withdraw:     '提现',
    redeem:       '兑换 →',
    howEarn:      '如何获得',
    pointsHint:   '1 积分 = 抵扣 ¥0.10。',
    earned:       '本月获得',
    redeemed:     '已兑换',
    history:      '记录',
    record:       '记录',
    filterAll:    '全部',
    filterIn:     '+ 入账',
    filterOut:    '− 支出',
    filterEarn:   '+ 获得',
    filterRedeem: '− 兑换',
    empty:        '暂无记录',
    withdrawSoon: '如需提现请联系客服。',
    redeemSoon:   '请在结算页面使用积分。',
    earnExplain:  '每消费 ¥100 累计 1 积分,充值另送奖励。',
  },
};

Page({
  data: {
    lang: 'en',
    copy: COPY.en,
    tab: 'wallet',
    walletFilter: 'all',
    pointsFilter: 'all',
    walletBal: '0.00',
    pointsBal: 0,
    pointsCash: '0.0',
    walletAll: [],
    walletFiltered: [],
    pointsAll: [],
    pointsFiltered: [],
    earnedThisMonth: 0,
    redeemedThisMonth: 0,
    monthLabel: '',
    showEarn: false,
  },

  onShow() {
    const app = getApp();
    const lang = app.globalData.lang === 'cn' ? 'cn' : 'en';
    this.setData({ lang, copy: COPY[lang] });
    this.updateMonthLabel();
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  updateMonthLabel() {
    const d = new Date();
    const mon = MONTH_ABBR[d.getMonth()];
    this.setData({ monthLabel: mon + ' ' + d.getFullYear() });
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }
    if (!app.globalData.token) return;

    try {
      const [cust, topups, points] = await Promise.all([
        api.get('/api/retail/customer').catch(() => null),
        api.get('/api/retail/topup/transactions?limit=100').catch(() => []),
        api.get('/api/retail/points/transactions?limit=100').catch(() => []),
      ]);

      const unwrap = (x) => Array.isArray(x) ? x : (x?.data || []);
      const next = {};

      if (cust) {
        next.walletBal  = Number(cust.balance || 0).toFixed(2);
        next.pointsBal  = cust.points_balance || 0;
        next.pointsCash = (next.pointsBal * 0.1).toFixed(1);
      }

      // Wallet history — only credit-style topup transactions for now.
      const walletAll = unwrap(topups)
        .filter(t => t.status === 'success')
        .map(t => {
          const parts = formatDateParts(t.paid_at || t.created_at);
          const isReferral = t.payment_method === 'referral_reward';
          const isAdjust   = t.payment_method === 'admin_adjust';
          const amount     = Number(t.amount);
          const sign       = amount >= 0 ? '+' : '−';
          const absStr     = Math.abs(amount).toLocaleString(undefined, { maximumFractionDigits: 2 });
          let label, cn, type;
          if (isReferral) {
            label = 'Referral reward'; cn = '推广奖励'; type = 'reward';
          } else if (isAdjust) {
            label = amount >= 0 ? 'Adjustment' : 'Clawback'; cn = '系统调整'; type = 'reward';
          } else {
            label = 'Top up · ¥' + amount.toLocaleString(); cn = '充值'; type = 'topup';
          }
          return {
            id:       't' + t.id,
            day:      parts.day,
            mon:      parts.mon,
            time:     parts.time,
            label,
            cn,
            amount,
            display:  sign + '¥' + absStr,
            type,
            bonus:    (t.bonus_points && t.bonus_points > 0) ? ('+' + t.bonus_points + ' PTS') : '',
          };
        });
      next.walletAll = walletAll;

      // Points history.
      const pointsAll = unwrap(points).map(p => {
        const parts = formatDateParts(p.created_at);
        const { type, bucket } = classifyPointsRow(p);
        const isPos = p.delta >= 0;
        const labelMap = {
          order_earn:     'Order · earned',
          topup_bonus:    'Top-up bonus',
          order_redeem:   'Redeemed at checkout',
          refund_reverse: 'Refund · reversed',
          admin_adjust:   'Adjustment',
          expiry:         'Expired',
          poll_vote:      'Vote · earned',
        };
        const cnMap = {
          order_earn:     '订单获得',
          topup_bonus:    '充值奖励',
          order_redeem:   '结算抵扣',
          refund_reverse: '退款冲销',
          admin_adjust:   '系统调整',
          expiry:         '已过期',
          poll_vote:      '投票获得',
        };
        // For earn rows that have an expires_at, show the date so the
        // customer knows when their batch lapses. Already-swept earns
        // (expired_at IS NOT NULL) are noted as such.
        const langCn = this.data.lang === 'cn';
        let expiryHint = '';
        if (p.delta > 0 && p.expires_at) {
          const exp = String(p.expires_at).slice(0, 10);
          if (p.expired_at) expiryHint = langCn ? '已过期 ' + exp : 'expired ' + exp;
          else              expiryHint = langCn ? '至 ' + exp : 'exp ' + exp;
        }
        return {
          id:      'p' + p.id,
          day:     parts.day,
          mon:     parts.mon,
          time:    parts.time,
          label:   labelMap[p.source] || (p.note || 'Points'),
          cn:      cnMap[p.source]    || '',
          amount:  p.delta,
          display: (isPos ? '+' : '−') + Math.abs(p.delta),
          type,
          bucket,
          expiryHint,
          expired: !!p.expired_at,
        };
      });
      next.pointsAll = pointsAll;

      // Month totals — based on now.
      const now = new Date();
      const ym  = now.getUTCFullYear() + '-' + String(now.getUTCMonth() + 1).padStart(2, '0');
      let earned = 0, redeemed = 0;
      for (const p of unwrap(points)) {
        if (!String(p.created_at).startsWith(ym)) continue;
        if (p.delta > 0) earned   += p.delta;
        else             redeemed += -p.delta;
      }
      next.earnedThisMonth   = earned;
      next.redeemedThisMonth = redeemed;

      this.setData(next);
      this.applyFilters();
    } catch (e) {
      console.warn('[wallet] refresh failed:', e.message);
    }
  },

  applyFilters() {
    const wf = this.data.walletFilter;
    const pf = this.data.pointsFilter;
    const walletFiltered = this.data.walletAll.filter(x => {
      if (wf === 'all') return true;
      if (wf === 'in')  return x.amount > 0;
      if (wf === 'out') return x.amount < 0;
      return true;
    });
    const pointsFiltered = this.data.pointsAll.filter(x => {
      if (pf === 'all') return true;
      return x.bucket === pf;
    });
    this.setData({ walletFiltered, pointsFiltered });
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  setWalletFilter(e) {
    this.setData({ walletFilter: e.currentTarget.dataset.id });
    this.applyFilters();
  },

  setPointsFilter(e) {
    this.setData({ pointsFilter: e.currentTarget.dataset.id });
    this.applyFilters();
  },

  openTopup() {
    wx.navigateTo({ url: '/pages/topup/topup' });
  },

  showWithdraw() {
    wx.showModal({
      title: this.data.copy.withdraw,
      content: this.data.copy.withdrawSoon,
      showCancel: false,
      confirmText: this.data.lang === 'cn' ? '好的' : 'OK',
    });
  },

  showRedeem() {
    wx.showModal({
      title: this.data.lang === 'cn' ? '兑换积分' : 'Redeem',
      content: this.data.copy.redeemSoon,
      showCancel: false,
      confirmText: this.data.lang === 'cn' ? '好的' : 'OK',
    });
  },

  openHowEarn() {
    this.setData({ showEarn: true });
  },

  closeHowEarn() {
    this.setData({ showEarn: false });
  },
});
