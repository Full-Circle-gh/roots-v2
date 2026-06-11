// Top-up — pre-pay store credit and earn bonus points. Mirrors design #13
// from the May 2026 mini-app handoff: editorial header, dark balance strip,
// 2×2 tier grid with sticker-style "BEST VALUE" tag, sticky pay footer.
//
// Packages come from /api/retail/topup-packages (CRUD'd in /retail-admin).
// Pay calls /api/retail/topup/create — in DEV the response is auto-finalised
// and we toast success; in PROD the response is `pending` and the office
// finalises the row manually until WeChat merchant cert lands.

const api = require('../../utils/api');

// Fallback point value ONLY if the server doesn't supply point_value_yuan
// (old backend). The real rate comes from points.redeemRate and is sent on the
// topup-packages response. Backend default is 100 pts/¥1 → ¥0.01 per point, so
// match that here rather than guessing higher. Bonus is awarded in POINTS, so a
// package's bonus is worth bonus_points × this rate — NOT bonus × ¥1.
const POINT_VALUE_YUAN = 0.01;

const TIER_BGS = ['#FFFCF7', 'var(--corn)', 'var(--papaya)', 'var(--lime)'];
const TIER_LABELS_EN = ['STARTER', 'REGULAR', 'PLUS', 'BEST VALUE'];
const TIER_LABELS_CN = ['入门', '常规', '高级', '最划算'];

Page({
  data: {
    lang: 'en',
    accent: '#CCD900',
    tiers: [],
    selectedIndex: 0,
    balanceDisplay: '0.00',
    pointsDisplay: '0',
    selectedAmount: '0',
    selectedBonus: 0,
    selectedTotal: '0',
    submitting: false,
    copy: {},
  },

  onLoad() {
    this.applyCopy();
  },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang || 'en' });
    this.applyCopy();
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  applyCopy() {
    const cn = this.data.lang === 'cn';
    this.setData({
      copy: {
        kicker:        cn ? '充值'                : 'TOP UP',
        kickerAlt:     cn ? 'TOP UP'              : '充值',
        headlineL1:    cn ? '更大的钱包,'         : 'Bigger wallet,',
        headlineL2A:   cn ? '更多的'              : 'bigger ',
        headlineL2B:   cn ? '福利'                : 'perks',
        headlineL2C:   cn ? '。'                  : '.',
        balanceLbl:    cn ? '余额'                : 'CURRENT BALANCE',
        balanceLblAlt: cn ? 'BALANCE'             : '余额',
        ptsSuffix:     cn ? '积分'                : 'PTS',
        historyLink:   cn ? '查看历史 →'          : 'HISTORY →',
        youPay:        cn ? '应付'                : 'YOU PAY',
        youPayAlt:     cn ? 'YOU PAY'             : '应付',
        youGet:        cn ? '到账'                : 'YOU GET',
        valueWord:     cn ? '总价值'              : 'VALUE',
        bonusWord:     cn ? '赠送'                : 'BONUS',
        ctaPrefix:     cn ? '微信支付'            : 'TOP UP',
        ctaSuffix:     cn ? '充值'                : 'VIA WECHAT',
        ptsShort:      cn ? '积分'                : 'pts',
        emptyTitle:    cn ? '暂无可购充值套餐'    : 'No packages yet',
        emptySub:      cn ? '请稍后再试,或联系客服。' : 'Check back soon or contact support.',
        loginPrompt:   cn ? '请先登录'            : 'Please sign in first',
        successMsg:    cn ? '充值成功'            : 'Top up successful',
        pendingMsg:    cn ? '订单已创建,等待支付确认' : 'Pending — awaiting payment confirmation',
        failedMsg:     cn ? '充值失败,请重试'    : 'Top up failed — please retry',
      },
    });
    this.recomputeSelected();
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }
    if (!app.globalData.token) {
      wx.showToast({ title: this.data.copy.loginPrompt, icon: 'none' });
      return;
    }

    try {
      const [cust, pkgs] = await Promise.all([
        api.get('/api/retail/customer').catch(() => null),
        api.get('/api/retail/topup-packages').catch(() => []),
      ]);

      const next = {};
      if (cust) {
        next.balanceDisplay = Number(cust.balance || 0).toFixed(2);
        next.pointsDisplay  = String(cust.points_balance || 0);
      }

      const rows = Array.isArray(pkgs) ? pkgs : (pkgs?.data || []);
      const cn = this.data.lang === 'cn';
      const tiers = rows.map((p, i) => {
        const amount = Number(p.amount || 0);
        const bonus  = Number(p.bonus_points || 0);
        // Value bonus points at the store's REAL redeem rate — the server sends
        // point_value_yuan (= 1 / points.redeemRate) on each row. utils/api.js
        // unwraps the response to `data`, so this MUST be read off the row, not
        // the envelope; a hardcoded guess is how "≈¥ value" / "% bonus" drifted.
        const pointValue = Number(p.point_value_yuan) > 0
          ? Number(p.point_value_yuan)
          : POINT_VALUE_YUAN;
        // Bonus is in points → convert to yuan before comparing against `amount`.
        const bonusYuan = bonus * pointValue;
        // Show the TRUE rate, not a whole-number round. ¥1000+50pts is 0.5%,
        // ¥2000+150pts is 0.75%, ¥3000+300pts is 1% — rounding to int made them
        // all read "1%", overstating the two smaller tiers. Trim trailing zeros.
        const pctRaw = amount > 0 ? (bonusYuan / amount) * 100 : 0;
        const pct    = parseFloat(pctRaw.toFixed(2));
        const totalYuan = amount + bonusYuan;
        const labelFallback = (cn ? TIER_LABELS_CN : TIER_LABELS_EN)[Math.min(i, 3)];
        return {
          id: p.id,
          amount,
          bonus,
          pct,
          amountDisplay: amount.toLocaleString(),
          totalDisplay:  Number(totalYuan.toFixed(2)).toLocaleString(),
          label: (cn ? (p.title_cn || labelFallback) : (p.title_en || labelFallback)).toUpperCase(),
          bg: TIER_BGS[i % TIER_BGS.length],
          best: false,
          numLabel: 'NO. ' + String(i + 1).padStart(2, '0'),
        };
      });

      if (tiers.length) tiers[tiers.length - 1].best = true;

      // Default selected: best-value (last) if 4+ exist, else middle.
      const selectedIndex = tiers.length >= 4
        ? tiers.length - 2
        : Math.max(0, tiers.length - 1);

      next.tiers = tiers;
      next.selectedIndex = selectedIndex;
      this.setData(next, () => this.recomputeSelected());
    } catch (e) {
      console.warn('[topup] refresh failed:', e.message);
    }
  },

  recomputeSelected() {
    const tiers = this.data.tiers || [];
    const i = this.data.selectedIndex;
    const t = tiers[i];
    if (!t) {
      this.setData({ selectedAmount: '0', selectedBonus: 0, selectedTotal: '0' });
      return;
    }
    this.setData({
      selectedAmount: t.amountDisplay,
      selectedBonus:  t.bonus,
      selectedTotal:  t.totalDisplay,
    });
  },

  selectTier(e) {
    const i = Number(e.currentTarget.dataset.i);
    if (!Number.isFinite(i) || i === this.data.selectedIndex) return;
    this.setData({ selectedIndex: i }, () => this.recomputeSelected());
  },

  goHistory() {
    wx.navigateTo({ url: '/pages/wallet/wallet' });
  },

  async topUp() {
    if (this.data.submitting) return;
    const t = this.data.tiers[this.data.selectedIndex];
    if (!t) return;

    this.setData({ submitting: true });
    wx.showLoading({ title: '...', mask: true });

    try {
      const res = await api.post('/api/retail/topup/create', {
        package_id: t.id,
        payment_method: 'wechat',
      });
      wx.hideLoading();

      // DEV mode: auto-finalised → refresh balance, toast success.
      if (res && (res.dev || res.status === 'success')) {
        wx.showToast({ title: this.data.copy.successMsg, icon: 'success' });
        this.refresh();
        return;
      }

      // PROD: real WeChat Pay. Server returned signed JSAPI params → invoke the
      // native pay sheet, then poll the top-up row until the async callback
      // credits the wallet.
      if (res && res.status === 'prepay' && res.paySign) {
        await this.payWithWechat(res);
        return;
      }

      // Legacy stub fallback (merchant cert not yet wired on this tenant):
      // server returned 'pending' → office finalises manually in admin.
      if (res && res.status === 'pending') {
        wx.showToast({ title: this.data.copy.pendingMsg, icon: 'none', duration: 2400 });
        return;
      }

      wx.showToast({ title: this.data.copy.successMsg, icon: 'success' });
      this.refresh();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: this.data.copy.failedMsg, icon: 'none' });
      console.warn('[topup] create failed:', e.message);
    } finally {
      this.setData({ submitting: false });
    }
  },

  // Invoke the WeChat native pay sheet with the server-signed params, then wait
  // for the async callback to settle the top-up. Resolves quietly either way —
  // the toast + balance refresh communicate the outcome. `submitting` stays
  // true (set by topUp, cleared in its finally) so the CTA can't be double-fired
  // while the pay sheet is open.
  payWithWechat(p) {
    return new Promise((resolve) => {
      wx.requestPayment({
        timeStamp: p.timeStamp,
        nonceStr:  p.nonceStr,
        package:   p.package,
        signType:  p.signType,
        paySign:   p.paySign,
        success: async () => {
          wx.showLoading({ title: '...', mask: true });
          const ok = await this.pollTopupStatus(p.topup_id);
          wx.hideLoading();
          wx.showToast({
            title:    ok ? this.data.copy.successMsg : this.data.copy.pendingMsg,
            icon:     ok ? 'success' : 'none',
            duration: ok ? 1500 : 2400,
          });
          this.refresh();
          resolve();
        },
        fail: () => {
          wx.showToast({ title: this.data.lang === 'cn' ? '支付未完成' : 'Payment incomplete', icon: 'none' });
          resolve();
        },
      });
    });
  },

  // Poll /topup/status for ~9s waiting for the WeChat callback to flip the row
  // to 'success'. Returns true once credited, false if still pending/failed —
  // the wallet refresh will reflect the balance whenever the callback lands.
  async pollTopupStatus(topupId) {
    if (!topupId) return false;
    for (let i = 0; i < 6; i++) {
      try {
        const row = await api.get('/api/retail/topup/status/' + topupId);
        if (row && row.status === 'success') return true;
        if (row && row.status === 'failed')  return false;
      } catch (_) { /* transient — keep polling */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  },
});
