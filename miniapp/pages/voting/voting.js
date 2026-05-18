// Voting — community polls (design page #23).
// One featured open poll on top (rendered as a big card with options),
// remaining open polls below as compact rows, then a "Past results" strip.
// Voting awards reward_points (default 5) once per poll.

const api = require('../../utils/api');

const COPY = {
  en: {
    navTitle:   'Your say',
    kicker:     'YOUR SAY',
    title1:     'You ',
    titleVote:  'vote',
    title2:     '.',
    title3:     'We listen.',
    intro:      'Every poll closes Sundays. Voting earns {pts} pts.',
    open:       'OPEN',
    left:       'LEFT',
    closed:     'CLOSED',
    castVote:   'CAST VOTE',
    pickOne:    'PICK ONE TO VOTE',
    voteCounted:'Vote counted.',
    ptsAdded:   '+{pts} pts added.',
    votesSoFar: '{n} VOTES SO FAR',
    share:      'SHARE →',
    otherPolls: 'OTHER OPEN POLLS',
    pastResults:'PAST RESULTS',
    winnerLbl:  'Winner: ',
    quote:      '"Your voice shapes the menu."',
    noOpen:     'No open polls right now. Check back soon.',
    pollDays:   '{n}d',
    voteFail:   'Could not record vote — try again.',
    pollEmpty:  'No polls yet.',
  },
  cn: {
    navTitle:   '投票',
    kicker:     '投票',
    title1:     '你',
    titleVote:  '投票',
    title2:     ',',
    title3:     '我们倾听。',
    intro:      '每周日截止,投票得 {pts} 积分。',
    open:       '进行中',
    left:       '剩余',
    closed:     '已结束',
    castVote:   '投票',
    pickOne:    '请选择',
    voteCounted:'已投票。',
    ptsAdded:   '+{pts} 积分。',
    votesSoFar: '已有 {n} 票',
    share:      '分享 →',
    otherPolls: '其他投票',
    pastResults:'已结束',
    winnerLbl:  '获胜者:',
    quote:      '"你的选择,塑造菜单。"',
    noOpen:     '暂无进行中的投票,请稍后再来。',
    pollDays:   '{n}天',
    voteFail:   '投票失败,请重试。',
    pollEmpty:  '暂无投票。',
  },
};

// Compute "N days left" (or hours/minutes for the final day) from an
// ISO closes_at string. Returns '' if no date or already past.
function daysLeft(closesAt) {
  if (!closesAt) return '';
  const t = new Date(String(closesAt).replace(' ', 'T') + 'Z').getTime();
  if (!t) return '';
  const ms = t - Date.now();
  if (ms <= 0) return '0';
  const days = Math.ceil(ms / 86400000);
  return String(days);
}

// Decorate a poll row for the WXML — adds % for each option, totalVotes,
// daysLeftStr, options-by-id index. Keeps server payload pristine in case
// we refetch.
function decorate(poll, lang) {
  const reward = poll.reward_points || 0;
  const total  = poll.total_votes || 0;
  const max    = poll.options.reduce((m, o) => Math.max(m, o.votes || 0), 0);
  const voted  = !!poll.my_vote_option_id;
  const isClosed = poll.status === 'closed';
  const showResults = voted || isClosed;
  return {
    ...poll,
    rewardPoints:  reward,
    totalVotes:    total,
    daysLeftStr:   daysLeft(poll.closes_at),
    voted,
    showResults,
    isClosed,
    options: poll.options.map((o, i) => {
      const pct = total > 0 ? (o.votes / total) * 100 : 0;
      return {
        ...o,
        letter:    String.fromCharCode(65 + i),
        pctStr:    pct.toFixed(0),
        pctWidth:  pct.toFixed(1) + '%',
        votesLbl:  (o.votes || 0).toLocaleString(),
        isMine:    o.id === poll.my_vote_option_id,
        isMax:     showResults && (o.votes || 0) === max && max > 0,
      };
    }),
  };
}

function format(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

Page({
  data: {
    lang: 'en',
    copy: COPY.en,
    loading: true,
    polls: [],         // all decorated polls
    featured: null,    // open poll shown big
    otherOpen: [],     // remaining open polls
    closed: [],        // past results
    chosenByPoll: {},  // pollId -> optionId (pre-vote local pick)
    introLine: '',
    titleLines: {},
  },

  onShow() {
    const app = getApp();
    const langKey = app.globalData.lang === 'cn' ? 'cn' : 'en';
    this.setData({
      lang: langKey,
      copy: COPY[langKey],
      titleLines: COPY[langKey],
    });
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
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
    try {
      const data = await api.get('/api/retail/polls');
      const rows = Array.isArray(data) ? data : [];
      const lang = this.data.lang;
      const decorated = rows.map(p => decorate(p, lang));
      const openPolls = decorated.filter(p => p.status === 'open');
      const closed    = decorated.filter(p => p.status === 'closed');

      // Featured = first explicitly is_featured, else first open
      let featured = openPolls.find(p => p.is_featured) || openPolls[0] || null;
      const otherOpen = openPolls.filter(p => !featured || p.id !== featured.id);

      const introLine = format(this.data.copy.intro, { pts: featured?.rewardPoints || 5 });

      this.setData({
        loading: false,
        polls: decorated,
        featured,
        otherOpen,
        closed,
        introLine,
      });
    } catch (e) {
      console.warn('[voting] refresh failed:', e.message);
      this.setData({ loading: false });
    }
  },

  // Pre-vote pick — track per-poll so the "cast vote" CTA can light up.
  pickOption(e) {
    const { pollId, optionId } = e.currentTarget.dataset;
    const poll = this.data.featured;
    if (!poll || poll.id !== pollId) return;
    if (poll.voted || poll.isClosed) return;
    const next = { ...this.data.chosenByPoll, [pollId]: optionId };
    this.setData({ chosenByPoll: next });
    // Highlight the chosen option in the featured card.
    const decorated = {
      ...poll,
      options: poll.options.map(o => ({ ...o, isChosen: o.id === optionId })),
    };
    this.setData({ featured: decorated });
  },

  async castVote(e) {
    const { pollId } = e.currentTarget.dataset;
    const chosen = this.data.chosenByPoll[pollId];
    if (!chosen) return;
    try {
      const res = await api.post(`/api/retail/polls/${pollId}/vote`, { option_id: chosen });
      // Server returns the updated poll incl. my_vote_option_id and refreshed totals.
      const updated = res?.poll || res?.data?.poll;
      if (updated) {
        const dec = decorate(updated, this.data.lang);
        this.setData({ featured: dec });
      } else {
        await this.refresh();
      }
      const reward = (res?.awarded_points != null) ? res.awarded_points : (this.data.featured?.rewardPoints || 0);
      if (reward > 0) {
        wx.showToast({
          title: this.data.lang === 'cn'
            ? `+${reward} 积分`
            : `+${reward} pts`,
          icon: 'success',
          duration: 1600,
        });
      }
      // Keep balance in sync on globalData so /me reflects the new total.
      const app = getApp();
      if (res?.points_balance != null && app.globalData.customer) {
        app.globalData.customer.points_balance = res.points_balance;
        try { wx.setStorageSync('customer', app.globalData.customer); } catch {}
      }
    } catch (err) {
      console.warn('[voting] vote failed:', err.message);
      wx.showToast({
        title: this.data.copy.voteFail,
        icon: 'none',
        duration: 1800,
      });
    }
  },

  openOtherPoll(e) {
    const { id } = e.currentTarget.dataset;
    const found = this.data.polls.find(p => p.id === id);
    if (!found) return;
    // Promote this poll to featured. Re-derive otherOpen / chosen / labels.
    const openPolls = this.data.polls.filter(p => p.status === 'open');
    const otherOpen = openPolls.filter(p => p.id !== found.id);
    const introLine = format(this.data.copy.intro, { pts: found.rewardPoints || 5 });
    this.setData({ featured: { ...found, options: found.options.map(o => ({ ...o, isChosen: o.id === found.my_vote_option_id })) }, otherOpen, introLine });
    wx.pageScrollTo({ scrollTop: 0, duration: 220 });
  },

  share() {
    wx.showToast({
      title: this.data.lang === 'cn' ? '请点右上角分享' : 'Tap ··· to share',
      icon: 'none',
      duration: 1600,
    });
  },

  onShareAppMessage() {
    const p = this.data.featured;
    return {
      title: p ? (this.data.lang === 'cn' && p.question_cn ? p.question_cn : p.question_en) : 'Vote with Roots',
      path: '/pages/voting/voting',
    };
  },
});
