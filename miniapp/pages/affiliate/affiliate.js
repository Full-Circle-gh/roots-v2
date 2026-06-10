// Refer-a-friend — design page #15.
// Reads /api/retail/affiliate (the program rules, the customer's code, their
// invite list + cached stats). Settings (enabled, ¥reward) come from the
// server — the customer can't change them; that's admin-only.

const api  = require('../../utils/api');

const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function dateLabel(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const day = String(parseInt(m[3], 10));
  const mon = MONTH_ABBR[parseInt(m[2], 10) - 1] || '';
  return mon + ' ' + day;
}

function firstInitial(s) {
  if (!s) return '?';
  const ch = String(s).trim().charAt(0).toUpperCase();
  return ch || '?';
}

const COPY = {
  en: {
    kicker:        'AFFILIATE',
    title1:        'Plant seeds.',
    title2:        'Reap rewards',
    tagline:       '¥30 for you, ¥30 for them. Every friend that orders.',
    earned:        'EARNED',
    invited:       'INVITED',
    joined:        'JOINED',
    yourCode:      'YOUR CODE',
    copy:          'COPY',
    wechat:        'WECHAT',
    moments:       'MOMENTS',
    how:           'HOW IT WORKS',
    how1:          'Share',
    how1sub:       'Send your code',
    how2:          'They order',
    how2sub:       'Friend joins + orders',
    how3:          'You earn',
    how3sub:       '¥{r} to your wallet',
    yourInvites:   'YOUR INVITES',
    applyHead:     'GOT A CODE?',
    applyPlaceholder: 'ROOTS-XXXXXX',
    apply:         'APPLY',
    referredByLabel: 'INVITED BY',
    empty:         'Share your code to start earning.',
    disabledTitle: 'Refer-a-friend is paused.',
    disabledBody:  'Our affiliate program is taking a short break. Check back soon — we will let you know when it returns.',
    shareTitle:    'INVITE FRIENDS',
    shareBody:     'Share this code with a friend. They get ¥30 off, you get ¥30 when they order.',
    close:         'CLOSE',
    statusJoined:  'JOINED · ¥{r}',
    statusOrdered: 'ORDERED · ¥{r}',
    statusVoid:    'VOIDED',
    toastCopied:   'Code copied',
    toastApplied:  'Code applied',
    toastShareSoon: 'Tap "..." and pick Moments to share.',
    errAlreadyReferred: 'You already applied a code.',
    errNotFound:        'Code not found.',
    errCannotSelf:      "That's your own code.",
    errProgram:         'Program is not running right now.',
    errMutual:          'You and that friend can\'t refer each other.',
    errGeneric:         "Couldn't apply that code. Please try again.",
  },
  cn: {
    kicker:        '推广计划',
    title1:        '种下种子,',
    title2:        '收获奖励',
    tagline:       '推荐好友下单,你得 ¥30,TA 也得 ¥30。',
    earned:        '已赚',
    invited:       '邀请',
    joined:        '加入',
    yourCode:      '邀请码',
    copy:          '复制',
    wechat:        '微信',
    moments:       '朋友圈',
    how:           '流程',
    how1:          '分享',
    how1sub:       '把邀请码发给朋友',
    how2:          '下单',
    how2sub:       '朋友注册并下单',
    how3:          '获奖',
    how3sub:       '到账 ¥{r}',
    yourInvites:   '我的邀请',
    applyHead:     '有邀请码?',
    applyPlaceholder: '请输入邀请码',
    apply:         '确认',
    referredByLabel: '邀请人',
    empty:         '邀请第一位朋友开始赚钱吧。',
    disabledTitle: '推广计划暂停中。',
    disabledBody:  '我们的推广计划暂时关闭,稍后会重新开放。',
    shareTitle:    '邀请好友',
    shareBody:     '把邀请码发给朋友,TA 得 ¥30 优惠,TA 下单后你得 ¥30。',
    close:         '关闭',
    statusJoined:  '加入 · ¥{r}',
    statusOrdered: '已下单 · ¥{r}',
    statusVoid:    '已失效',
    toastCopied:   '已复制',
    toastApplied:  '邀请码已应用',
    toastShareSoon: '点右上角"..."分享到朋友圈',
    errAlreadyReferred: '你已应用过邀请码。',
    errNotFound:        '邀请码不存在。',
    errCannotSelf:      '不能填自己的邀请码。',
    errProgram:         '推广计划暂未开放。',
    errMutual:          '互相邀请不可叠加。',
    errGeneric:         '邀请码应用失败,请重试。',
  },
};

Page({
  data: {
    lang: 'en',
    copy: COPY.en,
    loading: true,
    enabled: true,
    code: '',
    rewardPerOrder: 30,
    referredBy: null,
    canApply: false,
    applyInput: '',
    applyError: '',
    stats: { earned: '0.00', total_invites: 0, joined: 0, converted: 0 },
    invites: [],
    showQrModal: false,
    how3subResolved: '',
  },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.applyCopy();
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  applyCopy() {
    const copy = this.data.lang === 'cn' ? COPY.cn : COPY.en;
    this.setData({
      copy,
      how3subResolved: copy.how3sub.replace('{r}', String(this.data.rewardPerOrder || 30)),
    });
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }
    if (!app.globalData.token) {
      this.setData({ loading: false });
      return;
    }
    this.setData({ loading: true });
    try {
      const data = await api.get('/api/retail/affiliate');
      const reward = Number(data.reward_per_order) || 0;
      const invites = (data.invites || []).map(it => ({
        id: it.id,
        nickname: it.nickname || '',
        avatar_url: it.avatar_url || '',
        initial: firstInitial(it.nickname),
        dateLabel: dateLabel(it.joined_at || it.rewarded_at),
        status: it.status,
        statusLabel: this.labelForStatus(it.status, Number(it.reward_amount) || 0),
      }));
      this.setData({
        loading: false,
        enabled: data.enabled !== false,
        code: data.code || '',
        rewardPerOrder: reward,
        referredBy: data.referred_by || null,
        canApply: !data.referred_by && data.enabled !== false,
        stats: {
          earned: (Number(data.stats?.earned) || 0).toFixed(2),
          total_invites: data.stats?.total_invites || 0,
          joined: data.stats?.joined || 0,
          converted: data.stats?.converted || 0,
        },
        invites,
        how3subResolved: this.data.copy.how3sub.replace('{r}', String(reward || 30)),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || 'Failed', icon: 'none' });
    }
  },

  labelForStatus(status, reward) {
    const c = this.data.copy;
    const r = (reward || 0).toFixed(0);
    if (status === 'ordered') return c.statusOrdered.replace('{r}', r);
    if (status === 'joined')  return c.statusJoined.replace('{r}', r);
    return c.statusVoid;
  },

  copyCode() {
    if (!this.data.code) return;
    wx.setClipboardData({
      data: this.data.code,
      success: () => wx.showToast({ title: this.data.copy.toastCopied, icon: 'success' }),
    });
  },

  shareTimeline() {
    // Mini-program Moments share is gated on user gesture from the
    // right-corner menu; we can only nudge the user to use it.
    wx.showToast({ title: this.data.copy.toastShareSoon, icon: 'none', duration: 2500 });
  },

  showQr() {
    this.setData({ showQrModal: true });
  },

  closeQr() {
    this.setData({ showQrModal: false });
  },

  onApplyInput(e) {
    this.setData({
      applyInput: String(e.detail.value || '').toUpperCase().slice(0, 32),
      applyError: '',
    });
  },

  async applyCode() {
    const code = String(this.data.applyInput || '').trim().toUpperCase();
    if (!code) return;
    const c = this.data.copy;
    try {
      await api.post('/api/retail/affiliate/apply', { code });
      this.setData({ applyInput: '', applyError: '' });
      wx.showToast({ title: c.toastApplied, icon: 'success' });
      this.refresh();
    } catch (e) {
      const map = {
        already_referred:  c.errAlreadyReferred,
        code_not_found:    c.errNotFound,
        cannot_refer_self: c.errCannotSelf,
        program_disabled:  c.errProgram,
        mutual_referral:   c.errMutual,
      };
      // Only show mapped, localized messages. Unknown backend codes / raw
      // transport strings (e.g. 'network_…', 'server_error_500') would leak
      // developer text to the customer, so fall back to a generic message.
      this.setData({ applyError: map[e.message] || c.errGeneric });
    }
  },

  // WeChat-built-in share — the user taps the right-corner menu "..." or
  // the green "WECHAT" share button (open-type="share"). We attach the
  // referral code to a tracked link so when the friend opens the mini app
  // we can pre-fill the apply box on the affiliate page.
  onShareAppMessage() {
    const code = this.data.code || '';
    const reward = this.data.rewardPerOrder || 30;
    const en = this.data.lang === 'en';
    return {
      title: en
        ? `Get ¥${reward} off your first Roots order — code ${code}`
        : `Roots 邀请码 ${code} · 首单立减 ¥${reward}`,
      path: `/pages/affiliate/affiliate?ref=${encodeURIComponent(code)}`,
      imageUrl: '/assets/brand/share-affiliate.png',
    };
  },

  onShareTimeline() {
    const code = this.data.code || '';
    const reward = this.data.rewardPerOrder || 30;
    const en = this.data.lang === 'en';
    return {
      title: en
        ? `¥${reward} off your first Roots order — ${code}`
        : `Roots 首单立减 ¥${reward} · ${code}`,
      query: `ref=${encodeURIComponent(code)}`,
    };
  },

  onLoad(query) {
    // Enable share-to-Moments. WeChat only fires onShareTimeline (and surfaces
    // the Moments entry in the "..." menu) if the page opts in here — without
    // this call the onShareTimeline handler below is dead and Moments referral
    // sharing never works.
    if (typeof this.enableShareTimeline === 'function') {
      this.enableShareTimeline();
    }
    // If the page was opened from a shared link, pre-fill the apply box.
    if (query && query.ref) {
      this.setData({ applyInput: String(query.ref).toUpperCase().slice(0, 32) });
    }
  },
});
