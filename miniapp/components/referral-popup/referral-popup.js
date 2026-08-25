// One-time "refer a friend" popup for Home. Purely presentational — the
// parent (home.js) owns *when* it opens (once per session) and supplies the
// live affiliate data; this component only turns that data into copy and
// wires Copy/Share. Give/get amounts and the repeat-order bonus line use the
// exact same derivation as the affiliate_block banner (block-renderer.js)
// so the two surfaces can never disagree.
Component({
  properties: {
    open: { type: Boolean, value: false },
    affiliate: { type: Object, value: null },
    lang: { type: String, value: 'en' },
  },

  data: {
    kicker: '', title: '', subtitle: '', bonusLine: '',
    code: '', codeLabel: '', copyLabel: '', shareLabel: '', laterLabel: '',
  },

  observers: {
    'affiliate, lang': function (af, lang) {
      af = af || {};
      const en = lang !== 'cn';
      const rewardYou  = Number(af.reward_per_order) || 0;
      const rewardThem = Number(af.reward_referee) || 0;
      const lifeRate   = Number(af.lifetime_rate_percent) || 0;
      const lifeMonths = Number(af.lifetime_months) || 0;

      const title = rewardThem > 0
        ? (en ? `Give ¥${rewardThem}. Get ¥${rewardYou}.` : `好友得 ¥${rewardThem}，你得 ¥${rewardYou}。`)
        : (en ? `Get ¥${rewardYou} per friend.` : `每位好友 ¥${rewardYou}。`);

      // Repeat-order revenue share — only worth a line when the admin has
      // actually turned it on (rate > 0), same gate as the banner.
      const bonusLine = lifeRate > 0
        ? (en
            ? `+ ${lifeRate}% of their orders for ${lifeMonths > 0 ? `${lifeMonths} months` : 'life'}`
            : `另享好友日后订单 ${lifeRate}%${lifeMonths > 0 ? `，持续 ${lifeMonths} 个月` : '，长期有效'}`)
        : '';

      this.setData({
        kicker: en ? 'REFER A FRIEND' : '推广计划',
        title,
        subtitle: en ? 'Share your code. When they order, you both save.' : '分享邀请码,好友下单后双方各得奖励。',
        bonusLine,
        code: af.code || '',
        codeLabel: en ? 'YOUR CODE' : '邀请码',
        copyLabel: en ? 'COPY' : '复制',
        shareLabel: en ? 'SHARE YOUR CODE' : '分享邀请码',
        laterLabel: en ? 'Maybe later' : '稍后再说',
      });
    },
  },

  methods: {
    onClose() {
      this.triggerEvent('close');
    },
    // Same wx.setClipboardData + toast shape as the banner's
    // onAffiliateCopyTap (block-renderer.js), so the behavior matches.
    onCopyTap() {
      const code = this.data.code;
      if (!code) return;
      wx.setClipboardData({
        data: code,
        success: () => {
          wx.showToast({ title: this.data.lang === 'cn' ? '已复制' : 'Code copied', icon: 'success' });
        },
      });
    },
    // Stops a tap inside the card from bubbling to rp-bg's onClose.
    swallow() {},
  },
});
